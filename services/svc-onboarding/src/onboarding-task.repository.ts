import type { Queryable } from '@gadong/kernel'

export type TaskKey =
  | 'personal_data_collection'
  | 'document_upload'
  | 'contract_generation'
  | 'pdpa_consent'
  | 'sso_registration'
  | 'probation_review'

export type TaskStatus = 'pending' | 'completed'

export interface OnboardingTaskRow {
  id: string
  employeeId: string
  taskKey: TaskKey
  dueDate: string
  status: TaskStatus
}

export interface NewOnboardingTaskRow {
  employeeId: string
  taskKey: TaskKey
  dueDate: string
}

const SELECT_COLUMNS = 'id, employee_id, task_key, due_date, status'

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`OnboardingTaskRepository: unexpected date value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): OnboardingTaskRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    taskKey: row['task_key'] as TaskKey,
    dueDate: toDateString(row['due_date']),
    status: row['status'] as TaskStatus,
  }
}

/**
 * SQL for `onboarding.onboarding_task` — the checklist rows behind M1-2.
 * `insert` takes the CALLER's transaction handle `tx` so the whole
 * checklist an employee is created with commits atomically with the
 * `employee` row and the `employee.created` outbox event
 * (`checklist.service.ts`/`employee.service.ts`, ADR-005).
 */
export class OnboardingTaskRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewOnboardingTaskRow): Promise<OnboardingTaskRow> {
    const { rows } = await tx.query(
      `INSERT INTO onboarding.onboarding_task (employee_id, task_key, due_date, status)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SELECT_COLUMNS}`,
      [row.employeeId, row.taskKey, row.dueDate, 'pending'],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('OnboardingTaskRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findById(id: string): Promise<OnboardingTaskRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM onboarding.onboarding_task WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async findByEmployeeId(employeeId: string): Promise<OnboardingTaskRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM onboarding.onboarding_task WHERE employee_id = $1`,
      [employeeId],
    )
    return rows.map(mapRow)
  }

  /** No-op (returns `null`) if `id` does not exist. */
  async markCompleted(tx: Queryable, id: string): Promise<OnboardingTaskRow | null> {
    const { rows } = await tx.query(
      `UPDATE onboarding.onboarding_task SET status = $1 WHERE id = $2 RETURNING ${SELECT_COLUMNS}`,
      ['completed', id],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
