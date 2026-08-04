import type { Queryable } from '@gadong/kernel'

export type PunchDirection = 'in' | 'out'
export type PunchMethod = 'face' | 'pin' | 'qr' | 'badge' | 'manual'

export interface PunchRow {
  id: string
  idemKey: string
  employeeId: string
  deviceId: string
  punchedAt: string
  direction: PunchDirection
  method: PunchMethod
  matchScore: number | null
  livenessPassed: boolean | null
  siteCode: string
  geo: Record<string, unknown> | null
}

export interface NewPunchRow {
  id: string
  idemKey: string
  employeeId: string
  deviceId: string
  punchedAt: string
  direction: PunchDirection
  method: PunchMethod
  matchScore: number | null
  livenessPassed: boolean | null
  siteCode: string
  geo: Record<string, unknown> | null
}

export interface InsertPunchResult {
  row: PunchRow
  /** `true` when this call did NOT create a new row — `idem_key` already existed (the 24h-offline-kiosk-replay guarantee, M4-4/M4-6). `row` is the ORIGINAL row either way. */
  duplicate: boolean
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`PunchRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}
function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  if (Number.isNaN(n)) throw new Error(`PunchRepository: expected a numeric match_score, got ${JSON.stringify(v)}`)
  return n
}
function toBooleanOrNull(v: unknown): boolean | null {
  return v === null || v === undefined ? null : Boolean(v)
}
function toGeoOrNull(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v as Record<string, unknown>
  if (typeof v === 'string') return JSON.parse(v) as Record<string, unknown>
  throw new Error(`PunchRepository: unexpected geo value ${JSON.stringify(v)}`)
}

const SELECT_COLUMNS = 'id, idem_key, employee_id, device_id, punched_at, direction, method, match_score, liveness_passed, site_code, geo'

function mapRow(row: Record<string, unknown>): PunchRow {
  return {
    id: String(row['id']),
    idemKey: String(row['idem_key']),
    employeeId: String(row['employee_id']),
    deviceId: String(row['device_id']),
    punchedAt: toIsoString(row['punched_at']),
    direction: row['direction'] as PunchDirection,
    method: row['method'] as PunchMethod,
    matchScore: toNumberOrNull(row['match_score']),
    livenessPassed: toBooleanOrNull(row['liveness_passed']),
    siteCode: String(row['site_code']),
    geo: toGeoOrNull(row['geo']),
  }
}

/**
 * SQL for `attendance.punch_event`. `insert`'s
 * `ON CONFLICT (idem_key) DO NOTHING` IS the offline-kiosk-replay guarantee
 * (M4-4/M4-6 acceptance criterion: "no loss and no duplication") — not a
 * defence-in-depth measure alongside some other check, the entire
 * mechanism. `idem_key` is `device + seq`, unique per
 * `punch_event_idem_key_key` (schema migration).
 */
export class PunchRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewPunchRow): Promise<InsertPunchResult> {
    const { rows } = await tx.query(
      `INSERT INTO attendance.punch_event
         (id, idem_key, employee_id, device_id, punched_at, direction, method, match_score, liveness_passed, site_code, geo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (idem_key) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        row.id, row.idemKey, row.employeeId, row.deviceId, row.punchedAt, row.direction, row.method,
        row.matchScore, row.livenessPassed, row.siteCode, row.geo === null ? null : JSON.stringify(row.geo),
      ],
    )
    if (rows.length > 0 && rows[0] !== undefined) {
      return { row: mapRow(rows[0]), duplicate: false }
    }
    // No row RETURNED means the ON CONFLICT branch fired — idem_key already
    // existed. Fetch and return the ORIGINAL row so the caller (and the
    // HTTP response) reflects the punch that actually happened, not a
    // fabricated re-description of the request that arrived this time.
    const existing = await this.findByIdemKey(tx, row.idemKey)
    if (!existing) {
      throw new Error(`PunchRepository.insert: idem_key "${row.idemKey}" conflicted but no existing row was found`)
    }
    return { row: existing, duplicate: true }
  }

  async findByIdemKey(db: Queryable, idemKey: string): Promise<PunchRow | null> {
    const { rows } = await db.query(`SELECT ${SELECT_COLUMNS} FROM attendance.punch_event WHERE idem_key = $1`, [idemKey])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async listForEmployee(db: Queryable, employeeId: string, from: string, to: string): Promise<PunchRow[]> {
    const { rows } = await db.query(
      `SELECT ${SELECT_COLUMNS} FROM attendance.punch_event
       WHERE employee_id = $1 AND punched_at >= $2 AND punched_at <= $3
       ORDER BY punched_at DESC`,
      [employeeId, from, to],
    )
    return rows.map(mapRow)
  }
}
