import type { Queryable } from '@gadong/kernel'

export type SecurityEventKind = 'liveness_failed' | 'multi_face'

export interface SecurityEventRow {
  id: string
  kind: SecurityEventKind
  deviceId: string | null
  employeeId: string | null
  siteCode: string
  at: string
}

export interface NewSecurityEventRow {
  id: string
  kind: SecurityEventKind
  deviceId: string | null
  employeeId: string | null
  siteCode: string
  at: string
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`SecurityEventRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}
function toStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

const SELECT_COLUMNS = 'id, kind, device_id, employee_id, site_code, at'

function mapRow(row: Record<string, unknown>): SecurityEventRow {
  return {
    id: String(row['id']),
    kind: row['kind'] as SecurityEventKind,
    deviceId: toStringOrNull(row['device_id']),
    employeeId: toStringOrNull(row['employee_id']),
    siteCode: String(row['site_code']),
    at: toIsoString(row['at']),
  }
}

/** SQL for `attendance.security_event` — M4-3 (failed liveness) and M4-9 (multi-face anti-tailgating). No image/frame column — see the phase-3 migration's file header. */
export class SecurityEventRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewSecurityEventRow): Promise<SecurityEventRow> {
    const { rows } = await tx.query(
      `INSERT INTO attendance.security_event (id, kind, device_id, employee_id, site_code, at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_COLUMNS}`,
      [row.id, row.kind, row.deviceId, row.employeeId, row.siteCode, row.at],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('SecurityEventRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async listByKind(db: Queryable, kind: SecurityEventKind): Promise<SecurityEventRow[]> {
    const { rows } = await db.query(`SELECT ${SELECT_COLUMNS} FROM attendance.security_event WHERE kind = $1 ORDER BY at DESC`, [kind])
    return rows.map(mapRow)
  }
}
