import type { Queryable } from '@gadong/kernel'

export type ClaimStatus = 'draft' | 'pending' | 'approved' | 'for_payroll' | 'paid_offcycle' | 'rejected'
export type ReimbursementRoute = 'payroll' | 'offcycle'
export type ApprovalDecision = 'approved' | 'rejected'

export interface ClaimRow {
  id: string
  employeeId: string
  claimType: string
  amountThb: string
  status: ClaimStatus
  dupHash: string | null
  claimDate: string | null
  vendor: string | null
  mileageKm: string | null
  vatAmount: string | null
  reimbursementRoute: ReimbursementRoute | null
  rejectionReason: string | null
  round: number
  softLimitWarning: boolean
  submittedAt: string | null
  decidedAt: string | null
  routedAt: string | null
  paidAt: string | null
  fields: Record<string, unknown>
}

export interface NewClaimRow {
  employeeId: string
  claimType: string
  amountThb: string
  status: ClaimStatus
  dupHash: string | null
  claimDate: string | null
  vendor: string | null
  mileageKm: string | null
  vatAmount: string | null
  round: number
  softLimitWarning: boolean
  submittedAt: string | null
  fields: Record<string, unknown>
}

export interface ReceiptRow {
  id: string
  claimId: string
  /** Ciphertext (envelope-encrypted storage pointer) — see the `bytea`/S3-class comment on `claims.receipt.file_ref` in the migration. Never plaintext. */
  fileRef: Buffer
  vatAmount: string | null
}

export interface ApprovalStepRow {
  id: string
  subjectId: string
  level: number
  approverRole: string
  approverId: string | null
  decidedAt: string | null
  decision: ApprovalDecision | null
  comment: string | null
  round: number
}

const CLAIM_COLUMNS = `id, employee_id, claim_type, amount_thb, status, dup_hash, claim_date, vendor, mileage_km,
       vat_amount, reimbursement_route, rejection_reason, round, soft_limit_warning, submitted_at, decided_at,
       routed_at, paid_at, fields`
const RECEIPT_COLUMNS = `id, claim_id, file_ref, vat_amount`
const STEP_COLUMNS = `id, subject_id, level, approver_role, approver_id, decided_at, decision, comment, round`

function toNumericOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

function toDateStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`ClaimsRepository: unexpected date value ${JSON.stringify(v)}`)
}

function toIsoStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`ClaimsRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v
  throw new Error(`ClaimsRepository: expected file_ref to be a Buffer (bytea), got ${typeof v}`)
}

function mapClaim(row: Record<string, unknown>): ClaimRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    claimType: String(row['claim_type']),
    amountThb: String(row['amount_thb']),
    status: row['status'] as ClaimStatus,
    dupHash: row['dup_hash'] === null || row['dup_hash'] === undefined ? null : String(row['dup_hash']),
    claimDate: toDateStringOrNull(row['claim_date']),
    vendor: row['vendor'] === null || row['vendor'] === undefined ? null : String(row['vendor']),
    mileageKm: toNumericOrNull(row['mileage_km']),
    vatAmount: toNumericOrNull(row['vat_amount']),
    reimbursementRoute: (row['reimbursement_route'] as ReimbursementRoute | null) ?? null,
    rejectionReason:
      row['rejection_reason'] === null || row['rejection_reason'] === undefined ? null : String(row['rejection_reason']),
    round: Number(row['round']),
    softLimitWarning: Boolean(row['soft_limit_warning']),
    submittedAt: toIsoStringOrNull(row['submitted_at']),
    decidedAt: toIsoStringOrNull(row['decided_at']),
    routedAt: toIsoStringOrNull(row['routed_at']),
    paidAt: toIsoStringOrNull(row['paid_at']),
    fields: (row['fields'] as Record<string, unknown> | null) ?? {},
  }
}

function mapReceipt(row: Record<string, unknown>): ReceiptRow {
  return {
    id: String(row['id']),
    claimId: String(row['claim_id']),
    fileRef: toBuffer(row['file_ref']),
    vatAmount: toNumericOrNull(row['vat_amount']),
  }
}

function mapStep(row: Record<string, unknown>): ApprovalStepRow {
  return {
    id: String(row['id']),
    subjectId: String(row['subject_id']),
    level: Number(row['level']),
    approverRole: String(row['approver_role']),
    approverId: row['approver_id'] === null || row['approver_id'] === undefined ? null : String(row['approver_id']),
    decidedAt: toIsoStringOrNull(row['decided_at']),
    decision: (row['decision'] as ApprovalDecision | null) ?? null,
    comment: row['comment'] === null || row['comment'] === undefined ? null : String(row['comment']),
    round: Number(row['round']),
  }
}

/**
 * SQL only for `claims.claim` / `claims.receipt` / `claims.approval_step2`
 * (M6-2/M6-3/M6-5) — no business logic (submission, banding, limit
 * enforcement, routing) lives here; `claims.service.ts` owns that, matching
 * `services/svc-config`'s `service`/no-SQL split. Reads take a plain
 * `Queryable`; every write takes the CALLER's transaction handle so a
 * state change and its outbox event (`writeOutbox`, `claims.service.ts`)
 * commit or roll back together (ADR-005).
 */
export class ClaimsRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<ClaimRow | null> {
    const { rows } = await this.db.query(`SELECT ${CLAIM_COLUMNS} FROM claims.claim WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapClaim(rows[0]) : null
  }

  async listByEmployee(employeeId: string, status?: string): Promise<ClaimRow[]> {
    if (status) {
      const { rows } = await this.db.query(
        `SELECT ${CLAIM_COLUMNS} FROM claims.claim WHERE employee_id = $1 AND status = $2 ORDER BY submitted_at DESC NULLS LAST`,
        [employeeId, status],
      )
      return rows.map(mapClaim)
    }
    const { rows } = await this.db.query(
      `SELECT ${CLAIM_COLUMNS} FROM claims.claim WHERE employee_id = $1 ORDER BY submitted_at DESC NULLS LAST`,
      [employeeId],
    )
    return rows.map(mapClaim)
  }

  /** Every non-rejected, non-draft claim of `claimType` for `employeeId` whose `dup_hash` matches — M6-5 duplicate-receipt detection. Excludes `excludeClaimId` (a claim resubmitting itself must not flag against its own prior row). */
  async findActiveByDupHash(employeeId: string, claimType: string, dupHash: string, excludeClaimId: string | null): Promise<ClaimRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${CLAIM_COLUMNS} FROM claims.claim
       WHERE employee_id = $1 AND claim_type = $2 AND dup_hash = $3 AND status <> 'rejected' AND status <> 'draft'
         AND ($4::uuid IS NULL OR id <> $4::uuid)`,
      [employeeId, claimType, dupHash, excludeClaimId],
    )
    return rows.map(mapClaim)
  }

  /** Sum of `amount_thb` for every non-rejected, non-draft claim of `claimType` for `employeeId` with `claim_date` in `[fromDate, toDate)` — the M6-5 monthly/annual usage window. Excludes `excludeClaimId` so a resubmission recomputes its own tier fresh. Returns the raw `numeric` sum as a string (or `null` if there are no matching rows — `SUM` over zero rows is `NULL` in Postgres); the caller treats `null` as `"0"`. */
  async sumActiveAmount(
    employeeId: string,
    claimType: string,
    fromDate: string,
    toDate: string,
    excludeClaimId: string | null,
  ): Promise<string | null> {
    const { rows } = await this.db.query(
      `SELECT SUM(amount_thb) AS total FROM claims.claim
       WHERE employee_id = $1 AND claim_type = $2 AND status <> 'rejected' AND status <> 'draft'
         AND claim_date >= $3 AND claim_date < $4
         AND ($5::uuid IS NULL OR id <> $5::uuid)`,
      [employeeId, claimType, fromDate, toDate, excludeClaimId],
    )
    const total = rows[0]?.['total']
    return total === null || total === undefined ? null : String(total)
  }

  async insert(tx: Queryable, row: NewClaimRow): Promise<ClaimRow> {
    const { rows } = await tx.query(
      `INSERT INTO claims.claim
         (employee_id, claim_type, amount_thb, status, dup_hash, claim_date, vendor, mileage_km, vat_amount,
          round, soft_limit_warning, submitted_at, fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       RETURNING ${CLAIM_COLUMNS}`,
      [
        row.employeeId,
        row.claimType,
        row.amountThb,
        row.status,
        row.dupHash,
        row.claimDate,
        row.vendor,
        row.mileageKm,
        row.vatAmount,
        row.round,
        row.softLimitWarning,
        row.submittedAt,
        JSON.stringify(row.fields),
      ],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ClaimsRepository.insert: INSERT ... RETURNING produced no row')
    return mapClaim(inserted)
  }

  /** Applies the fields a resubmission (M6-3) changes: amount/date/vendor/mileage/VAT/fields, a new round, status reset to `pending`, rejection cleared. */
  async applyResubmission(
    tx: Queryable,
    id: string,
    fields: {
      amountThb: string
      dupHash: string | null
      claimDate: string | null
      vendor: string | null
      mileageKm: string | null
      vatAmount: string | null
      round: number
      softLimitWarning: boolean
      fields: Record<string, unknown>
    },
  ): Promise<ClaimRow> {
    const { rows } = await tx.query(
      `UPDATE claims.claim
       SET amount_thb = $2, dup_hash = $3, claim_date = $4, vendor = $5, mileage_km = $6, vat_amount = $7,
           round = $8, soft_limit_warning = $9, status = 'pending', rejection_reason = NULL, submitted_at = now(),
           decided_at = NULL, fields = $10::jsonb
       WHERE id = $1
       RETURNING ${CLAIM_COLUMNS}`,
      [
        id,
        fields.amountThb,
        fields.dupHash,
        fields.claimDate,
        fields.vendor,
        fields.mileageKm,
        fields.vatAmount,
        fields.round,
        fields.softLimitWarning,
        JSON.stringify(fields.fields),
      ],
    )
    const updated = rows[0]
    if (updated === undefined) throw new Error('ClaimsRepository.applyResubmission: UPDATE ... RETURNING produced no row')
    return mapClaim(updated)
  }

  async markRejected(tx: Queryable, id: string, reason: string): Promise<ClaimRow> {
    const { rows } = await tx.query(
      `UPDATE claims.claim SET status = 'rejected', rejection_reason = $2, decided_at = now() WHERE id = $1 RETURNING ${CLAIM_COLUMNS}`,
      [id, reason],
    )
    const updated = rows[0]
    if (updated === undefined) throw new Error('ClaimsRepository.markRejected: UPDATE ... RETURNING produced no row')
    return mapClaim(updated)
  }

  async markApproved(tx: Queryable, id: string): Promise<ClaimRow> {
    const { rows } = await tx.query(
      `UPDATE claims.claim SET status = 'approved', decided_at = now() WHERE id = $1 RETURNING ${CLAIM_COLUMNS}`,
      [id],
    )
    const updated = rows[0]
    if (updated === undefined) throw new Error('ClaimsRepository.markApproved: UPDATE ... RETURNING produced no row')
    return mapClaim(updated)
  }

  async route(tx: Queryable, id: string, route: ReimbursementRoute): Promise<ClaimRow> {
    const newStatus = route === 'payroll' ? 'for_payroll' : 'paid_offcycle'
    const paidAtExpr = route === 'offcycle' ? 'now()' : 'NULL'
    const { rows } = await tx.query(
      `UPDATE claims.claim SET status = $2, reimbursement_route = $3, routed_at = now(), paid_at = ${paidAtExpr}
       WHERE id = $1 RETURNING ${CLAIM_COLUMNS}`,
      [id, newStatus, route],
    )
    const updated = rows[0]
    if (updated === undefined) throw new Error('ClaimsRepository.route: UPDATE ... RETURNING produced no row')
    return mapClaim(updated)
  }

  async insertReceipt(tx: Queryable, claimId: string, fileRef: Buffer, vatAmount: string | null): Promise<ReceiptRow> {
    const { rows } = await tx.query(
      `INSERT INTO claims.receipt (claim_id, file_ref, vat_amount) VALUES ($1, $2, $3) RETURNING ${RECEIPT_COLUMNS}`,
      [claimId, fileRef, vatAmount],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ClaimsRepository.insertReceipt: INSERT ... RETURNING produced no row')
    return mapReceipt(inserted)
  }

  async listReceipts(claimId: string): Promise<ReceiptRow[]> {
    const { rows } = await this.db.query(`SELECT ${RECEIPT_COLUMNS} FROM claims.receipt WHERE claim_id = $1`, [claimId])
    return rows.map(mapReceipt)
  }

  async insertApprovalSteps(
    tx: Queryable,
    claimId: string,
    round: number,
    approverRoles: string[],
  ): Promise<ApprovalStepRow[]> {
    const inserted: ApprovalStepRow[] = []
    for (let i = 0; i < approverRoles.length; i++) {
      const { rows } = await tx.query(
        `INSERT INTO claims.approval_step2 (subject_id, level, approver_role, round)
         VALUES ($1, $2, $3, $4)
         RETURNING ${STEP_COLUMNS}`,
        [claimId, i + 1, approverRoles[i], round],
      )
      const row = rows[0]
      if (row === undefined) throw new Error('ClaimsRepository.insertApprovalSteps: INSERT ... RETURNING produced no row')
      inserted.push(mapStep(row))
    }
    return inserted
  }

  async listApprovalSteps(claimId: string, round: number): Promise<ApprovalStepRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${STEP_COLUMNS} FROM claims.approval_step2 WHERE subject_id = $1 AND round = $2 ORDER BY level`,
      [claimId, round],
    )
    return rows.map(mapStep)
  }

  async decideStep(
    tx: Queryable,
    stepId: string,
    approverId: string,
    decision: ApprovalDecision,
    comment: string | null,
  ): Promise<ApprovalStepRow> {
    const { rows } = await tx.query(
      `UPDATE claims.approval_step2 SET approver_id = $2, decision = $3, comment = $4, decided_at = now()
       WHERE id = $1 RETURNING ${STEP_COLUMNS}`,
      [stepId, approverId, decision, comment],
    )
    const updated = rows[0]
    if (updated === undefined) throw new Error('ClaimsRepository.decideStep: UPDATE ... RETURNING produced no row')
    return mapStep(updated)
  }
}
