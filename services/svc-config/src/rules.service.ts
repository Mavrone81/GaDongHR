import { GadongError, resolveEffective, sodViolation, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { RulesRepository } from './rules.repository'
import type { GovernanceClass, NewRuleRow, StatutoryRuleRow } from './rules.repository'

export interface ProposeRuleInput {
  ruleKey: string
  value: unknown
  unit: string
  statutoryFloor?: unknown
  statutoryCeiling?: unknown
  citation: string
  effectiveFrom: string
  effectiveTo?: string | null
  governanceClass: GovernanceClass
  reason: string
  proposedBy: string
}

function ruleNotFound(ruleKey: string, on: string): GadongError {
  return new GadongError('CFG-404', 'config.error.rule_not_found', 404, [{ ruleKey, on }])
}
function ruleVersionNotFound(id: string): GadongError {
  return new GadongError('CFG-404', 'config.error.rule_version_not_found', 404, [{ id }])
}
function notDraft(id: string): GadongError {
  return new GadongError('CFG-409', 'config.error.not_a_draft', 409, [{ id }])
}

/**
 * `governance_class = 'STATUTORY_FIXED'` values change only through a
 * signed pack import (`packs.service.ts`) — never a hand edit (Task 7
 * brief §3). Reused across both propose-time checks below.
 */
function statutoryFixedNotEditable(ruleKey: string): GadongError {
  return new GadongError('CFG-403', 'config.error.statutory_fixed_not_editable', 403, [{ ruleKey }])
}

/**
 * The response **must carry the citation** (Task 7 brief §3) — an HR admin
 * who cannot see which law blocked them will just try again. `details[0]`
 * always carries `citation` for both the floor and ceiling cases.
 */
function statutoryFloorViolation(ruleKey: string, value: unknown, floor: unknown, citation: string): GadongError {
  return new GadongError('CFG-422', 'config.error.below_statutory_floor', 422, [
    { ruleKey, value, statutoryFloor: floor, citation },
  ])
}
function statutoryCeilingViolation(ruleKey: string, value: unknown, ceiling: unknown, citation: string): GadongError {
  return new GadongError('CFG-422', 'config.error.above_statutory_ceiling', 422, [
    { ruleKey, value, statutoryCeiling: ceiling, citation },
  ])
}

/**
 * Business logic behind `/rules*` — no SQL here (`rules.repository.ts`
 * owns that), matching the `services/svc-crypto` file split. Every write
 * path takes the caller's transaction handle `tx`, so `approve()`'s status
 * change and its `rules.updated` outbox row commit or roll back together
 * (kernel `writeOutbox`, ADR-005).
 */
export class RulesService {
  constructor(
    private readonly repo: RulesRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private today(): string {
    const iso = this.now().toISOString()
    return iso.slice(0, 10)
  }

  /** `GET /rules/:key?on=` — resolves via kernel `resolveEffective`; `on` defaults to today. 404 (not a bypass) when no version is effective on that date — this is the M7-2 shape: Sept 2026 has no EWF row in force at all. */
  async getEffective(ruleKey: string, on?: string): Promise<StatutoryRuleRow> {
    const targetDate = on ?? this.today()
    const rows = await this.repo.findActiveByKey(ruleKey)
    const resolved = resolveEffective(rows, targetDate)
    if (!resolved) throw ruleNotFound(ruleKey, targetDate)
    return resolved
  }

  /** `GET /rules?prefix=` — the current-effective row (today) for every distinct key under `prefix`. */
  async listCurrent(prefix: string): Promise<StatutoryRuleRow[]> {
    const rows = await this.repo.findActiveByPrefix(prefix)
    const byKey = new Map<string, StatutoryRuleRow[]>()
    for (const row of rows) {
      const list = byKey.get(row.ruleKey)
      if (list) list.push(row)
      else byKey.set(row.ruleKey, [row])
    }
    const today = this.today()
    const resolved: StatutoryRuleRow[] = []
    for (const versions of byKey.values()) {
      const current = resolveEffective(versions, today)
      if (current) resolved.push(current)
    }
    return resolved.sort((a, b) => a.ruleKey.localeCompare(b.ruleKey))
  }

  /**
   * `POST /rules` — creates `status = 'draft'`. Rejects a `STATUTORY_FIXED`
   * key outright (`CFG-403`) — whether the *existing* row for this key is
   * fixed, or the caller merely claims `governanceClass: 'STATUTORY_FIXED'`
   * for what would otherwise be a brand-new key; either way, hand-editing a
   * fixed value is not a code path this method has. `STATUTORY_FLOOR`
   * proposals are validated against the floor/ceiling carried on the
   * proposal itself (Statutory Spec §1 — floor and value are sibling
   * fields on one row) before any row is written.
   */
  async propose(tx: Queryable, input: ProposeRuleInput): Promise<StatutoryRuleRow> {
    const existing = await this.repo.findLatestByKey(input.ruleKey)
    if (existing?.governanceClass === 'STATUTORY_FIXED' || input.governanceClass === 'STATUTORY_FIXED') {
      throw statutoryFixedNotEditable(input.ruleKey)
    }

    this.assertWithinFloorAndCeiling(
      input.ruleKey,
      input.value,
      input.governanceClass,
      input.statutoryFloor ?? null,
      input.statutoryCeiling ?? null,
      input.citation,
    )

    const row: NewRuleRow = {
      ruleKey: input.ruleKey,
      value: input.value,
      unit: input.unit,
      statutoryFloor: input.statutoryFloor ?? null,
      statutoryCeiling: input.statutoryCeiling ?? null,
      citation: input.citation,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      governanceClass: input.governanceClass,
      status: 'draft',
      proposedBy: input.proposedBy,
      approvedBy: null,
      reason: input.reason,
    }
    return this.repo.insert(tx, row)
  }

  /**
   * `POST /rules/:id/approve` — activates a `draft` row. Segregation of
   * duties (Task 7 brief §3, "braces"): `proposedBy === approvedBy` is
   * rejected here with the kernel's `sodViolation()` (`AUZ-409`) — the same
   * rule the DB CHECK constraint enforces independently (the "belt"; see
   * `rules.repository.test.ts`'s "DB CHECK constraint" suite and the
   * migration). Publishes `rules.updated` to the outbox in the SAME
   * transaction as the status change (kernel `writeOutbox`).
   */
  async approve(tx: Queryable, id: string, approvedBy: string): Promise<StatutoryRuleRow> {
    const row = await this.repo.findById(id)
    if (!row) throw ruleVersionNotFound(id)
    if (row.status !== 'draft') throw notDraft(id)

    if (row.proposedBy !== null && row.proposedBy === approvedBy) {
      throw sodViolation('config.rule.approve')
    }

    const approved = await this.repo.approve(tx, id, approvedBy)
    if (!approved) throw notDraft(id) // lost a race with a concurrent approval

    await writeOutbox(tx, 'config', 'rules.updated', {
      ruleKeys: [approved.ruleKey],
      effectiveFrom: approved.effectiveFrom,
    })

    return approved
  }

  private assertWithinFloorAndCeiling(
    ruleKey: string,
    value: unknown,
    governanceClass: GovernanceClass,
    floor: unknown,
    ceiling: unknown,
    citation: string,
  ): void {
    if (governanceClass !== 'STATUTORY_FLOOR') return
    // Only plain-number value/floor/ceiling pairs are compared — a handful
    // of compound rules (e.g. `hours.break.min_after`) carry a structured
    // jsonb shape the Statutory Spec never reduces to one number, and this
    // check has no defined comparison for those (Task 7 report, "known
    // limitations"). The real case this guards — `leave.annual.min_days`
    // proposed below its floor — is a plain number on both sides.
    if (typeof value === 'number' && typeof floor === 'number' && value < floor) {
      throw statutoryFloorViolation(ruleKey, value, floor, citation)
    }
    if (typeof value === 'number' && typeof ceiling === 'number' && value > ceiling) {
      throw statutoryCeilingViolation(ruleKey, value, ceiling, citation)
    }
  }
}
