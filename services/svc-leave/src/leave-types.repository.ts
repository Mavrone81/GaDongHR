import type { Queryable } from '@gadong/kernel'

export type PayMode = 'full' | 'half' | 'unpaid' | 'per_rule'
export type AccrualMode = 'annual_grant' | 'monthly' | 'anniversary'

export interface LeaveTypeRow {
  id: string
  code: string
  nameI18n: Record<string, string>
  payMode: PayMode
  accrualMode: AccrualMode
  statutoryRuleKey: string | null
  /** `numeric` as a string — see `decimal.ts`'s file header for why this is never a JS `number`. `null` for per-certificate types (e.g. sterilization) with no fixed entitlement. */
  entitlementDays: string | null
  unit: string
  payRatePercent: string
  carryOverEnabled: boolean
  allowsHalfDay: boolean
  allowsHourly: boolean
  certTriggerDays: string | null
  certTriggerRuleKey: string | null
  citation: string | null
  active: boolean
}

export interface NewLeaveTypeRow {
  id: string
  code: string
  nameI18n: Record<string, string>
  payMode: PayMode
  accrualMode: AccrualMode
  statutoryRuleKey: string | null
  entitlementDays: string | null
  unit: string
  payRatePercent: string
  carryOverEnabled: boolean
  allowsHalfDay: boolean
  allowsHourly: boolean
  certTriggerDays: string | null
  certTriggerRuleKey: string | null
  citation: string | null
  active: boolean
}

export interface LeaveTypePatch {
  nameI18n?: Record<string, string>
  entitlementDays?: string | null
  payRatePercent?: string
  carryOverEnabled?: boolean
  allowsHalfDay?: boolean
  allowsHourly?: boolean
  certTriggerDays?: string | null
  citation?: string | null
  active?: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function toStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

function mapRow(row: Record<string, unknown>): LeaveTypeRow {
  const nameI18n = row['name_i18n']
  return {
    id: String(row['id']),
    code: String(row['code']),
    nameI18n: isRecord(nameI18n) ? (nameI18n as Record<string, string>) : {},
    payMode: row['pay_mode'] as PayMode,
    accrualMode: row['accrual_mode'] as AccrualMode,
    statutoryRuleKey: toStringOrNull(row['statutory_rule_key']),
    entitlementDays: toStringOrNull(row['entitlement_days']),
    unit: String(row['unit']),
    payRatePercent: String(row['pay_rate_percent']),
    carryOverEnabled: Boolean(row['carry_over_enabled']),
    allowsHalfDay: Boolean(row['allows_half_day']),
    allowsHourly: Boolean(row['allows_hourly']),
    certTriggerDays: toStringOrNull(row['cert_trigger_days']),
    certTriggerRuleKey: toStringOrNull(row['cert_trigger_rule_key']),
    citation: toStringOrNull(row['citation']),
    active: Boolean(row['active']),
  }
}

/**
 * SQL only — no floor-checking or governance logic here (`leave-types.service.ts`
 * owns that), matching `services/svc-config`'s `rules.repository.ts`/
 * `rules.service.ts` split. Read methods take a plain `Queryable`; write
 * methods take the CALLER's transaction handle `tx`, so a type write and any
 * outbox event it produces commit or roll back together.
 */
export class LeaveTypesRepository {
  constructor(private readonly db: Queryable) {}

  async findAll(): Promise<LeaveTypeRow[]> {
    const { rows } = await this.db.query('SELECT * FROM leave.leave_type')
    return rows.map(mapRow)
  }

  async findById(id: string): Promise<LeaveTypeRow | null> {
    const { rows } = await this.db.query('SELECT * FROM leave.leave_type WHERE id = $1', [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async findByCode(code: string): Promise<LeaveTypeRow | null> {
    const { rows } = await this.db.query('SELECT * FROM leave.leave_type WHERE code = $1', [code])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async insert(tx: Queryable, row: NewLeaveTypeRow): Promise<LeaveTypeRow> {
    const { rows } = await tx.query(
      `INSERT INTO leave.leave_type
         (id, code, name_i18n, pay_mode, accrual_mode, statutory_rule_key, entitlement_days, unit,
          pay_rate_percent, carry_over_enabled, allows_half_day, allows_hourly, cert_trigger_days,
          cert_trigger_rule_key, citation, active)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        row.id,
        row.code,
        JSON.stringify(row.nameI18n),
        row.payMode,
        row.accrualMode,
        row.statutoryRuleKey,
        row.entitlementDays,
        row.unit,
        row.payRatePercent,
        row.carryOverEnabled,
        row.allowsHalfDay,
        row.allowsHourly,
        row.certTriggerDays,
        row.certTriggerRuleKey,
        row.citation,
        row.active,
      ],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('LeaveTypesRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** Builds a dynamic `SET` clause from whichever `patch` fields are present — only the columns actually being changed appear in the SQL text (and its `$n` params), matching the fake DB's "bare `$n` placeholder per assignment" contract. */
  async update(tx: Queryable, id: string, patch: LeaveTypePatch): Promise<LeaveTypeRow | null> {
    const assignments: string[] = []
    const params: unknown[] = [id]

    const push = (column: string, value: unknown, cast?: string): void => {
      params.push(value)
      assignments.push(`${column} = $${params.length}${cast ? `::${cast}` : ''}`)
    }

    if (patch.nameI18n !== undefined) push('name_i18n', JSON.stringify(patch.nameI18n), 'jsonb')
    if (patch.entitlementDays !== undefined) push('entitlement_days', patch.entitlementDays)
    if (patch.payRatePercent !== undefined) push('pay_rate_percent', patch.payRatePercent)
    if (patch.carryOverEnabled !== undefined) push('carry_over_enabled', patch.carryOverEnabled)
    if (patch.allowsHalfDay !== undefined) push('allows_half_day', patch.allowsHalfDay)
    if (patch.allowsHourly !== undefined) push('allows_hourly', patch.allowsHourly)
    if (patch.certTriggerDays !== undefined) push('cert_trigger_days', patch.certTriggerDays)
    if (patch.citation !== undefined) push('citation', patch.citation)
    if (patch.active !== undefined) push('active', patch.active)

    if (assignments.length === 0) return this.findById(id)

    const { rows } = await tx.query(
      `UPDATE leave.leave_type SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
