import type { Queryable } from '@gadong/kernel'
import type { ConfigClient } from './config-client'
import { belowStatutoryFloor, leaveTypeNotFound, statutoryRuleNotResolved } from './errors'
import { LeaveTypesRepository } from './leave-types.repository'
import type { AccrualMode, LeaveTypePatch, LeaveTypeRow, NewLeaveTypeRow, PayMode } from './leave-types.repository'
import * as Decimal from './decimal'

export interface CreateLeaveTypeInput {
  id?: string
  code: string
  nameI18n: Record<string, string>
  payMode: PayMode
  accrualMode: AccrualMode
  /** Binds this type to its floor in `config.statutory_rule` (M5-1). `null`/omitted for a company-defined type with no statutory floor. */
  statutoryRuleKey?: string | null
  entitlementDays?: string | null
  unit?: string
  payRatePercent?: string
  carryOverEnabled?: boolean
  allowsHalfDay?: boolean
  allowsHourly?: boolean
  certTriggerDays?: string | null
  certTriggerRuleKey?: string | null
  active?: boolean
}

export interface UpdateLeaveTypeInput {
  nameI18n?: Record<string, string>
  entitlementDays?: string | null
  payRatePercent?: string
  carryOverEnabled?: boolean
  allowsHalfDay?: boolean
  allowsHourly?: boolean
  certTriggerDays?: string | null
  active?: boolean
}

function isPlainNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Business logic behind `/types*` — no SQL here (`leave-types.repository.ts`
 * owns that), matching `services/svc-config`'s `service`/repository split.
 *
 * `assertNotBelowFloor` is THIS MODULE'S single most important method (Task
 * brief: "That rejection is the single most important interaction in this
 * module — it is the product's compliance argument made visible"). It never
 * compares against a literal — the floor and citation are always whatever
 * `ConfigClient.getEffectiveRule` answers for the given `ruleKey` AT CALL
 * TIME, which is exactly what lets "raising an entitlement is allowed;
 * lowering below the statutory floor is rejected with the citation shown"
 * move when the underlying config value moves (Task brief TESTS: "prove
 * [config-drivenness] by changing a config value and asserting behaviour
 * moves with it").
 */
export class LeaveTypesService {
  constructor(
    private readonly repo: LeaveTypesRepository,
    private readonly config: ConfigClient,
    private readonly genId: () => string,
  ) {}

  async list(): Promise<LeaveTypeRow[]> {
    return this.repo.findAll()
  }

  async getById(id: string): Promise<LeaveTypeRow> {
    const row = await this.repo.findById(id)
    if (!row) throw leaveTypeNotFound(id)
    return row
  }

  async create(tx: Queryable, input: CreateLeaveTypeInput): Promise<LeaveTypeRow> {
    let citation: string | null = null

    if (input.statutoryRuleKey) {
      citation = await this.assertNotBelowFloor(input.statutoryRuleKey, input.entitlementDays ?? null)
    }
    if (input.certTriggerRuleKey) {
      await this.assertNotBelowFloor(input.certTriggerRuleKey, input.certTriggerDays ?? null)
    }

    const row: NewLeaveTypeRow = {
      id: input.id ?? this.genId(),
      code: input.code,
      nameI18n: input.nameI18n,
      payMode: input.payMode,
      accrualMode: input.accrualMode,
      statutoryRuleKey: input.statutoryRuleKey ?? null,
      entitlementDays: input.entitlementDays ?? null,
      unit: input.unit ?? 'days',
      payRatePercent: input.payRatePercent ?? '100',
      carryOverEnabled: input.carryOverEnabled ?? false,
      allowsHalfDay: input.allowsHalfDay ?? true,
      allowsHourly: input.allowsHourly ?? false,
      certTriggerDays: input.certTriggerDays ?? null,
      certTriggerRuleKey: input.certTriggerRuleKey ?? null,
      citation,
      active: input.active ?? true,
    }
    return this.repo.insert(tx, row)
  }

  async update(tx: Queryable, id: string, patch: UpdateLeaveTypeInput): Promise<LeaveTypeRow> {
    const existing = await this.repo.findById(id)
    if (!existing) throw leaveTypeNotFound(id)

    if (patch.entitlementDays !== undefined && existing.statutoryRuleKey) {
      await this.assertNotBelowFloor(existing.statutoryRuleKey, patch.entitlementDays)
    }
    if (patch.certTriggerDays !== undefined && existing.certTriggerRuleKey) {
      await this.assertNotBelowFloor(existing.certTriggerRuleKey, patch.certTriggerDays)
    }

    const repoPatch: LeaveTypePatch = {
      nameI18n: patch.nameI18n,
      entitlementDays: patch.entitlementDays,
      payRatePercent: patch.payRatePercent,
      carryOverEnabled: patch.carryOverEnabled,
      allowsHalfDay: patch.allowsHalfDay,
      allowsHourly: patch.allowsHourly,
      certTriggerDays: patch.certTriggerDays,
      active: patch.active,
    }
    const updated = await this.repo.update(tx, id, repoPatch)
    if (!updated) throw leaveTypeNotFound(id)
    return updated
  }

  /**
   * Resolves `ruleKey`'s current-effective row from `svc-config` and — only
   * when that rule carries a numeric `statutoryFloor` (a `STATUTORY_FLOOR`
   * governance-class rule; `COMPANY_POLICY` rules carry `null`) — rejects
   * `value` if it is below that floor, citing the rule's `citation`.
   * Returns the citation on success so callers (`create`) can stamp it onto
   * the new row without a second round-trip.
   *
   * `value === null` (a type declaring no fixed entitlement, e.g.
   * sterilization "as certified by physician") is never compared against a
   * floor — there is nothing to compare.
   */
  private async assertNotBelowFloor(ruleKey: string, value: string | null): Promise<string> {
    const rule = await this.config.getEffectiveRule(ruleKey)
    if (!rule) throw statutoryRuleNotResolved(ruleKey)

    if (value !== null && isPlainNumber(rule.statutoryFloor)) {
      if (Decimal.compare(value, String(rule.statutoryFloor)) < 0) {
        throw belowStatutoryFloor(ruleKey, value, rule.statutoryFloor, rule.citation)
      }
    }
    return rule.citation
  }
}
