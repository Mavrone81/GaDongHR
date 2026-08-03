import type { Queryable } from '@gadong/kernel'

export type LimitKind = 'hard' | 'soft'

export interface ClaimTypeRow {
  code: string
  name: string
  perClaimLimit: string | null
  perClaimLimitKind: LimitKind | null
  monthlyLimit: string | null
  monthlyLimitKind: LimitKind | null
  annualLimit: string | null
  annualLimitKind: LimitKind | null
  receiptRequired: boolean
  requiredFields: string[]
  mileageRate: string | null
  active: boolean
  createdAt: string
}

export interface NewClaimTypeRow {
  code: string
  name: string
  perClaimLimit: string | null
  perClaimLimitKind: LimitKind | null
  monthlyLimit: string | null
  monthlyLimitKind: LimitKind | null
  annualLimit: string | null
  annualLimitKind: LimitKind | null
  receiptRequired: boolean
  requiredFields: string[]
  mileageRate: string | null
  active: boolean
}

const SELECT_COLUMNS = `code, name, per_claim_limit, per_claim_limit_kind, monthly_limit, monthly_limit_kind,
       annual_limit, annual_limit_kind, receipt_required, required_fields, mileage_rate, active, created_at`

function toNumericOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`ClaimTypesRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): ClaimTypeRow {
  return {
    code: String(row['code']),
    name: String(row['name']),
    perClaimLimit: toNumericOrNull(row['per_claim_limit']),
    perClaimLimitKind: (row['per_claim_limit_kind'] as LimitKind | null) ?? null,
    monthlyLimit: toNumericOrNull(row['monthly_limit']),
    monthlyLimitKind: (row['monthly_limit_kind'] as LimitKind | null) ?? null,
    annualLimit: toNumericOrNull(row['annual_limit']),
    annualLimitKind: (row['annual_limit_kind'] as LimitKind | null) ?? null,
    receiptRequired: Boolean(row['receipt_required']),
    requiredFields: (row['required_fields'] as string[] | null) ?? [],
    mileageRate: toNumericOrNull(row['mileage_rate']),
    active: Boolean(row['active']),
    createdAt: toIsoString(row['created_at']),
  }
}

/**
 * SQL only for `claims.claim_type` (M6-1) — no validation lives here; that
 * is `claim-types.service.ts`'s job, matching `services/svc-config`'s
 * `service`/no-SQL split. Reads take a plain `Queryable` (the service's
 * pool); writes take the CALLER's transaction handle so a create/update and
 * any future outbox event it grows would commit or roll back together.
 */
export class ClaimTypesRepository {
  constructor(private readonly db: Queryable) {}

  async list(): Promise<ClaimTypeRow[]> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM claims.claim_type ORDER BY code`)
    return rows.map(mapRow)
  }

  async findByCode(code: string): Promise<ClaimTypeRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM claims.claim_type WHERE code = $1`, [code])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async insert(tx: Queryable, row: NewClaimTypeRow): Promise<ClaimTypeRow> {
    const { rows } = await tx.query(
      `INSERT INTO claims.claim_type
         (code, name, per_claim_limit, per_claim_limit_kind, monthly_limit, monthly_limit_kind,
          annual_limit, annual_limit_kind, receipt_required, required_fields, mileage_rate, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
       RETURNING ${SELECT_COLUMNS}`,
      [
        row.code,
        row.name,
        row.perClaimLimit,
        row.perClaimLimitKind,
        row.monthlyLimit,
        row.monthlyLimitKind,
        row.annualLimit,
        row.annualLimitKind,
        row.receiptRequired,
        JSON.stringify(row.requiredFields),
        row.mileageRate,
        row.active,
      ],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ClaimTypesRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** Full-row replace of every mutable column (the update surface `PATCH /types/:id` exposes) — `code` is the identity and never changes. Returns `null` if `code` does not exist. */
  async update(tx: Queryable, code: string, row: Omit<NewClaimTypeRow, 'code'>): Promise<ClaimTypeRow | null> {
    const { rows } = await tx.query(
      `UPDATE claims.claim_type
       SET name = $2, per_claim_limit = $3, per_claim_limit_kind = $4, monthly_limit = $5, monthly_limit_kind = $6,
           annual_limit = $7, annual_limit_kind = $8, receipt_required = $9, required_fields = $10::jsonb,
           mileage_rate = $11, active = $12
       WHERE code = $1
       RETURNING ${SELECT_COLUMNS}`,
      [
        code,
        row.name,
        row.perClaimLimit,
        row.perClaimLimitKind,
        row.monthlyLimit,
        row.monthlyLimitKind,
        row.annualLimit,
        row.annualLimitKind,
        row.receiptRequired,
        JSON.stringify(row.requiredFields),
        row.mileageRate,
        row.active,
      ],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
