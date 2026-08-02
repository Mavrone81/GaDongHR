import type { Queryable } from '@gadong/kernel'

export type GovernanceClass = 'STATUTORY_FLOOR' | 'STATUTORY_FIXED' | 'COMPANY_POLICY'
export type RuleStatus = 'draft' | 'pending_approval' | 'active' | 'superseded'

export interface StatutoryRuleRow {
  id: string
  ruleKey: string
  value: unknown
  unit: string
  statutoryFloor: unknown
  statutoryCeiling: unknown
  citation: string
  effectiveFrom: string
  effectiveTo: string | null
  governanceClass: GovernanceClass
  status: RuleStatus
  proposedBy: string | null
  approvedBy: string | null
  reason: string | null
  createdAt: string
}

export interface NewRuleRow {
  ruleKey: string
  value: unknown
  unit: string
  statutoryFloor: unknown
  statutoryCeiling: unknown
  citation: string
  effectiveFrom: string
  effectiveTo: string | null
  governanceClass: GovernanceClass
  status: RuleStatus
  proposedBy: string | null
  approvedBy: string | null
  reason: string | null
}

const SELECT_COLUMNS = `id, rule_key, value, unit, statutory_floor, statutory_ceiling, citation,
       effective_from, effective_to, governance_class, status, proposed_by, approved_by, reason, created_at`

/**
 * Postgres's `date` OID (1082) is parsed by node-postgres into a local-time
 * JS `Date`, not the `YYYY-MM-DD` string the column actually holds — a
 * well-known `pg` driver gotcha. `resolveEffective` (kernel) compares
 * `effectiveFrom`/`effectiveTo` lexicographically as strings, so a `Date`
 * that round-trips through a different timezone than the server would
 * silently resolve the wrong rule version. This repository never trusts the
 * driver's parsed type for a date column — it always re-derives the ISO
 * date string itself.
 */
function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`RulesRepository: unexpected date value ${JSON.stringify(v)}`)
}

function toDateStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : toDateString(v)
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`RulesRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): StatutoryRuleRow {
  return {
    id: String(row['id']),
    ruleKey: String(row['rule_key']),
    value: row['value'],
    unit: String(row['unit']),
    statutoryFloor: row['statutory_floor'] ?? null,
    statutoryCeiling: row['statutory_ceiling'] ?? null,
    citation: String(row['citation']),
    effectiveFrom: toDateString(row['effective_from']),
    effectiveTo: toDateStringOrNull(row['effective_to']),
    governanceClass: row['governance_class'] as GovernanceClass,
    status: row['status'] as RuleStatus,
    proposedBy: row['proposed_by'] === null || row['proposed_by'] === undefined ? null : String(row['proposed_by']),
    approvedBy: row['approved_by'] === null || row['approved_by'] === undefined ? null : String(row['approved_by']),
    reason: row['reason'] === null || row['reason'] === undefined ? null : String(row['reason']),
    createdAt: toIsoString(row['created_at']),
  }
}

/**
 * SQL only — no business logic (governance, floor checks, SoD) lives here;
 * that is `rules.service.ts`'s job (Task 7 brief file layout, matching
 * `services/svc-crypto`'s `service`/no-SQL split).
 *
 * Read methods take a plain `Queryable` (usually the service's pool) and
 * write methods take the CALLER's transaction handle `tx` — the same
 * contract `writeOutbox`/`idempotent` use — so a write and its outbox
 * event commit or roll back together (kernel `withTransaction`).
 */
export class RulesRepository {
  constructor(private readonly db: Queryable) {}

  /** All `active` rows whose key starts with `prefix` — the service resolves each key's current-effective row from these via `resolveEffective`. */
  async findActiveByPrefix(prefix: string): Promise<StatutoryRuleRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM config.statutory_rule WHERE status = 'active' AND rule_key LIKE $1`,
      [`${prefix}%`],
    )
    return rows.map(mapRow)
  }

  /** All `active` rows for one key — the service resolves the one that applies `on` a given date via `resolveEffective`. */
  async findActiveByKey(ruleKey: string): Promise<StatutoryRuleRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM config.statutory_rule WHERE status = 'active' AND rule_key = $1`,
      [ruleKey],
    )
    return rows.map(mapRow)
  }

  /**
   * The most recently opened row for `ruleKey`, in any status. Used to
   * decide whether a key is locked to `STATUTORY_FIXED` (pack-import only)
   * before a `POST /rules` proposal is allowed to reach the floor check.
   */
  async findLatestByKey(ruleKey: string): Promise<StatutoryRuleRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM config.statutory_rule WHERE rule_key = $1 ORDER BY effective_from DESC LIMIT 1`,
      [ruleKey],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async findById(id: string): Promise<StatutoryRuleRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM config.statutory_rule WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async insert(tx: Queryable, row: NewRuleRow): Promise<StatutoryRuleRow> {
    const { rows } = await tx.query(
      `INSERT INTO config.statutory_rule
         (rule_key, value, unit, statutory_floor, statutory_ceiling, citation, effective_from, effective_to,
          governance_class, status, proposed_by, approved_by, reason)
       VALUES ($1, $2::jsonb, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${SELECT_COLUMNS}`,
      [
        row.ruleKey,
        JSON.stringify(row.value),
        row.unit,
        JSON.stringify(row.statutoryFloor ?? null),
        JSON.stringify(row.statutoryCeiling ?? null),
        row.citation,
        row.effectiveFrom,
        row.effectiveTo,
        row.governanceClass,
        row.status,
        row.proposedBy,
        row.approvedBy,
        row.reason,
      ],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('RulesRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** Activates a `draft` row. No-op (returns `null`) if `id` does not exist or is not currently `draft` — the service turns that into `CFG-404`/`CFG-409`. */
  async approve(tx: Queryable, id: string, approvedBy: string): Promise<StatutoryRuleRow | null> {
    const { rows } = await tx.query(
      `UPDATE config.statutory_rule SET status = 'active', approved_by = $2
       WHERE id = $1 AND status = 'draft'
       RETURNING ${SELECT_COLUMNS}`,
      [id, approvedBy],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
