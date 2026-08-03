import type { Queryable } from '@gadong/kernel'

export type ApprovalDecision = 'approved' | 'rejected'

export interface ApprovalStepRow {
  id: string
  subjectId: string
  level: number
  approverRole: string
  /** The ASSIGNED approver for this level — `null` when the level has no pre-assigned approver and any holder of `leave.approve` may decide it. */
  approverId: string | null
  decidedAt: string | null
  decision: ApprovalDecision | null
  comment: string | null
  /** Who actually clicked decide — distinct from `approverId` under delegation. See the leave-business migration's file header. */
  decidedBy: string | null
}

export interface NewApprovalStepRow {
  id: string
  subjectId: string
  level: number
  approverRole: string
  approverId: string | null
}

export interface ApprovalLevelRow {
  id: string
  leaveTypeId: string
  level: number
  approverRole: string
  minDays: string
}

export interface DelegationRow {
  id: string
  approverId: string
  delegateId: string
  startsOn: string
  endsOn: string
}

export interface NewDelegationRow {
  id: string
  approverId: string
  delegateId: string
  startsOn: string
  endsOn: string
}

function mapStepRow(row: Record<string, unknown>): ApprovalStepRow {
  const decidedAt = row['decided_at']
  return {
    id: String(row['id']),
    subjectId: String(row['subject_id']),
    level: Number(row['level']),
    approverRole: String(row['approver_role']),
    approverId: row['approver_id'] === null || row['approver_id'] === undefined ? null : String(row['approver_id']),
    decidedAt: decidedAt === null || decidedAt === undefined ? null : decidedAt instanceof Date ? decidedAt.toISOString() : String(decidedAt),
    decision: row['decision'] === null || row['decision'] === undefined ? null : (row['decision'] as ApprovalDecision),
    comment: row['comment'] === null || row['comment'] === undefined ? null : String(row['comment']),
    decidedBy: row['decided_by'] === null || row['decided_by'] === undefined ? null : String(row['decided_by']),
  }
}

function mapLevelRow(row: Record<string, unknown>): ApprovalLevelRow {
  return {
    id: String(row['id']),
    leaveTypeId: String(row['leave_type_id']),
    level: Number(row['level']),
    approverRole: String(row['approver_role']),
    minDays: String(row['min_days']),
  }
}

function mapDelegationRow(row: Record<string, unknown>): DelegationRow {
  return {
    id: String(row['id']),
    approverId: String(row['approver_id']),
    delegateId: String(row['delegate_id']),
    startsOn: String(row['starts_on']),
    endsOn: String(row['ends_on']),
  }
}

/** SQL for `approval_step`, `approval_level` (chain configuration) and `approver_delegation` — no chain-resolution or decision logic here (`approvals.service.ts` owns that). */
export class ApprovalsRepository {
  constructor(private readonly db: Queryable) {}

  async insertStep(tx: Queryable, row: NewApprovalStepRow): Promise<ApprovalStepRow> {
    const { rows } = await tx.query(
      `INSERT INTO leave.approval_step (id, subject_id, level, approver_role, approver_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [row.id, row.subjectId, row.level, row.approverRole, row.approverId],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ApprovalsRepository.insertStep: INSERT ... RETURNING produced no row')
    return mapStepRow(inserted)
  }

  async findStepById(id: string): Promise<ApprovalStepRow | null> {
    const { rows } = await this.db.query('SELECT * FROM leave.approval_step WHERE id = $1', [id])
    return rows.length > 0 && rows[0] !== undefined ? mapStepRow(rows[0]) : null
  }

  async listStepsBySubject(subjectId: string): Promise<ApprovalStepRow[]> {
    const { rows } = await this.db.query('SELECT * FROM leave.approval_step WHERE subject_id = $1', [subjectId])
    return rows.map(mapStepRow).sort((a, b) => a.level - b.level)
  }

  async decideStep(tx: Queryable, id: string, decision: ApprovalDecision, decidedBy: string, comment: string | null, decidedAt: Date): Promise<ApprovalStepRow | null> {
    const { rows } = await tx.query(
      `UPDATE leave.approval_step SET decision = $2, decided_by = $3, comment = $4, decided_at = $5 WHERE id = $1 RETURNING *`,
      [id, decision, decidedBy, comment, decidedAt],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapStepRow(rows[0]) : null
  }

  async listLevelsForType(leaveTypeId: string): Promise<ApprovalLevelRow[]> {
    const { rows } = await this.db.query('SELECT * FROM leave.approval_level WHERE leave_type_id = $1', [leaveTypeId])
    return rows.map(mapLevelRow).sort((a, b) => a.level - b.level)
  }

  async insertLevel(tx: Queryable, row: { id: string; leaveTypeId: string; level: number; approverRole: string; minDays: string }): Promise<ApprovalLevelRow> {
    const { rows } = await tx.query(
      `INSERT INTO leave.approval_level (id, leave_type_id, level, approver_role, min_days) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [row.id, row.leaveTypeId, row.level, row.approverRole, row.minDays],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ApprovalsRepository.insertLevel: INSERT ... RETURNING produced no row')
    return mapLevelRow(inserted)
  }

  async insertDelegation(tx: Queryable, row: NewDelegationRow): Promise<DelegationRow> {
    const { rows } = await tx.query(
      `INSERT INTO leave.approver_delegation (id, approver_id, delegate_id, starts_on, ends_on) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [row.id, row.approverId, row.delegateId, row.startsOn, row.endsOn],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ApprovalsRepository.insertDelegation: INSERT ... RETURNING produced no row')
    return mapDelegationRow(inserted)
  }

  /** Every delegation grant FOR `approverId` — the service filters by date range (a fixed-shape equality WHERE keeps this fake-DB-friendly; see `testing/fake-db.ts`'s header). */
  async listDelegationsForApprover(approverId: string): Promise<DelegationRow[]> {
    const { rows } = await this.db.query('SELECT * FROM leave.approver_delegation WHERE approver_id = $1', [approverId])
    return rows.map(mapDelegationRow)
  }
}
