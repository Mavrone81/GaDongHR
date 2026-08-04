import type { Queryable } from '@gadong/kernel'

export type EnrolmentMethod = 'face' | 'pin' | 'qr' | 'badge'
export type EnrolmentStatus = 'active' | 'suspended' | 'deleted'

export interface EnrolmentRow {
  id: string
  employeeId: string
  method: EnrolmentMethod
  /** Opaque CompreFace subject id ONLY — see `attendance-schema.test.ts`. Null for a pin/qr/badge-only enrolment. */
  faceSubjectRef: string | null
  status: EnrolmentStatus
  enrolledAt: string
  templateDeletedAt: string | null
}

export interface NewEnrolmentRow {
  id: string
  employeeId: string
  method: EnrolmentMethod
  faceSubjectRef: string | null
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`EnrolmentRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}
function toIsoStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : toIsoString(v)
}

const SELECT_COLUMNS = 'id, employee_id, method, face_subject_ref, status, enrolled_at, template_deleted_at'

function mapRow(row: Record<string, unknown>): EnrolmentRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    method: row['method'] as EnrolmentMethod,
    faceSubjectRef: row['face_subject_ref'] === null || row['face_subject_ref'] === undefined ? null : String(row['face_subject_ref']),
    status: row['status'] as EnrolmentStatus,
    enrolledAt: toIsoString(row['enrolled_at']),
    templateDeletedAt: toIsoStringOrNull(row['template_deleted_at']),
  }
}

/** SQL for `attendance.enrollment` — the sole row of "how does this employee clock in" per M4-1/M4-5. `face_subject_ref` never carries an embedding — see the schema migration's file-level comment and `attendance-schema.test.ts`. */
export class EnrolmentRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewEnrolmentRow): Promise<EnrolmentRow> {
    const { rows } = await tx.query(
      `INSERT INTO attendance.enrollment (id, employee_id, method, face_subject_ref, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING ${SELECT_COLUMNS}`,
      [row.id, row.employeeId, row.method, row.faceSubjectRef],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('EnrolmentRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findByEmployeeId(db: Queryable, employeeId: string): Promise<EnrolmentRow | null> {
    const { rows } = await db.query(`SELECT ${SELECT_COLUMNS} FROM attendance.enrollment WHERE employee_id = $1`, [employeeId])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Reverse lookup for the kiosk 1:N flow: CompreFace's `identify` returns a `subjectRef`, and the punch pipeline needs to know WHICH employee that opaque id belongs to. */
  async findByFaceSubjectRef(db: Queryable, faceSubjectRef: string): Promise<EnrolmentRow | null> {
    const { rows } = await db.query(`SELECT ${SELECT_COLUMNS} FROM attendance.enrollment WHERE face_subject_ref = $1`, [faceSubjectRef])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** PDPA §7: stamps verified-deletion evidence. Only ever called AFTER `FaceEngineAdapter.deleteSubject` returned `verified: true` — never speculatively. */
  async markTemplateDeleted(tx: Queryable, employeeId: string, deletedAt: string): Promise<EnrolmentRow | null> {
    const { rows } = await tx.query(
      `UPDATE attendance.enrollment SET status = 'deleted', template_deleted_at = $2 WHERE employee_id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [employeeId, deletedAt],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
