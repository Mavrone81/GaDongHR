import type { Queryable } from '@gadong/kernel'

export type DeviceKind = 'kiosk' | 'mobile'
export type DeviceStatus = 'pending' | 'active' | 'revoked'

export interface DeviceRow {
  id: string
  kind: DeviceKind
  siteCode: string
  /** 🔐 S3 — envelope-encrypted by `svc-crypto` before every INSERT/UPDATE. Never decrypted except to verify an incoming HMAC signature. */
  deviceSecret: Buffer
  status: DeviceStatus
  registeredBy: string | null
  approvedBy: string | null
  approvedAt: string | null
}

export interface NewDeviceRow {
  id: string
  kind: DeviceKind
  siteCode: string
  deviceSecret: Buffer
  registeredBy: string
}

function toIsoStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`DeviceRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}
function toBuffer(v: unknown, field: string): Buffer {
  if (Buffer.isBuffer(v)) return v
  throw new Error(`DeviceRepository: expected ${field} to be a Buffer (bytea), got ${typeof v}`)
}
function toStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

const SELECT_COLUMNS = 'id, kind, site_code, device_secret, status, registered_by, approved_by, approved_at'

function mapRow(row: Record<string, unknown>): DeviceRow {
  return {
    id: String(row['id']),
    kind: row['kind'] as DeviceKind,
    siteCode: String(row['site_code']),
    deviceSecret: toBuffer(row['device_secret'], 'device_secret'),
    status: row['status'] as DeviceStatus,
    registeredBy: toStringOrNull(row['registered_by']),
    approvedBy: toStringOrNull(row['approved_by']),
    approvedAt: toIsoStringOrNull(row['approved_at']),
  }
}

/** SQL for `attendance.device`. `device_secret` is the one legitimate bytea column outside `alternative_credential.credential_hash` — see the schema migrations' file headers. */
export class DeviceRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewDeviceRow): Promise<DeviceRow> {
    const { rows } = await tx.query(
      `INSERT INTO attendance.device (id, kind, site_code, device_secret, status, registered_by)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING ${SELECT_COLUMNS}`,
      [row.id, row.kind, row.siteCode, row.deviceSecret, row.registeredBy],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('DeviceRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findById(db: Queryable, id: string): Promise<DeviceRow | null> {
    const { rows } = await db.query(`SELECT ${SELECT_COLUMNS} FROM attendance.device WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async list(db: Queryable): Promise<DeviceRow[]> {
    const { rows } = await db.query(`SELECT ${SELECT_COLUMNS} FROM attendance.device ORDER BY site_code`)
    return rows.map(mapRow)
  }

  /** Second-person approval — `approvedBy !== registeredBy` is enforced by `DeviceService`, not here (this repository has no notion of "the caller"). */
  async approve(tx: Queryable, id: string, approvedBy: string, approvedAt: string): Promise<DeviceRow | null> {
    const { rows } = await tx.query(
      `UPDATE attendance.device SET status = 'active', approved_by = $2, approved_at = $3 WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [id, approvedBy, approvedAt],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
