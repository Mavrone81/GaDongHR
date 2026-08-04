import type { Queryable } from '@gadong/kernel'

export type AlternativeKind = 'pin' | 'qr' | 'badge'

export interface AlternativeCredentialRow {
  employeeId: string
  kind: AlternativeKind
  credentialHash: Buffer
  createdAt: string
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`AlternativeCredentialRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}
function toBuffer(v: unknown, field: string): Buffer {
  if (Buffer.isBuffer(v)) return v
  throw new Error(`AlternativeCredentialRepository: expected ${field} to be a Buffer (bytea), got ${typeof v}`)
}

const SELECT_COLUMNS = 'employee_id, kind, credential_hash, created_at'

function mapRow(row: Record<string, unknown>): AlternativeCredentialRow {
  return {
    employeeId: String(row['employee_id']),
    kind: row['kind'] as AlternativeKind,
    credentialHash: toBuffer(row['credential_hash'], 'credential_hash'),
    createdAt: toIsoString(row['created_at']),
  }
}

/** SQL for `attendance.alternative_credential` (M4-5). Never stores a raw PIN/QR/badge code — see `credential-hash.ts`. */
export class AlternativeCredentialRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(tx: Queryable, employeeId: string, kind: AlternativeKind, credentialHash: Buffer): Promise<AlternativeCredentialRow> {
    const { rows } = await tx.query(
      `INSERT INTO attendance.alternative_credential (employee_id, kind, credential_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id) DO UPDATE SET kind = EXCLUDED.kind, credential_hash = EXCLUDED.credential_hash
       RETURNING ${SELECT_COLUMNS}`,
      [employeeId, kind, credentialHash],
    )
    const row = rows[0]
    if (row === undefined) throw new Error('AlternativeCredentialRepository.upsert: INSERT ... RETURNING produced no row')
    return mapRow(row)
  }

  async findByEmployeeId(db: Queryable, employeeId: string): Promise<AlternativeCredentialRow | null> {
    const { rows } = await db.query(`SELECT ${SELECT_COLUMNS} FROM attendance.alternative_credential WHERE employee_id = $1`, [employeeId])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** QR/badge lookup: the scanned code alone must resolve to exactly one employee — `alternative_credential_hash_key UNIQUE` is why this can only ever return 0 or 1 rows. */
  async findByHash(db: Queryable, credentialHash: Buffer): Promise<AlternativeCredentialRow | null> {
    const { rows } = await db.query(`SELECT ${SELECT_COLUMNS} FROM attendance.alternative_credential WHERE credential_hash = $1`, [credentialHash])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
