import type { Queryable } from '@gadong/kernel'

export type EmploymentType = 'monthly' | 'daily' | 'hourly' | 'contract'
export type EmployeeStatus = 'draft' | 'onboarding' | 'active' | 'cancelled' | 'terminated'
export type Lang = 'th' | 'en' | 'zh'
export type ClockInMethod = 'biometric' | 'alternative'

/**
 * Every 🔐 column (migration's ERD comment) is `Buffer` here — ciphertext,
 * never a decoded string. `EmployeeService` is the only caller allowed to
 * turn one of these into plaintext, and only through `CryptoClient.decrypt`
 * with a purpose (M1-1 acceptance criterion). This repository never
 * decrypts anything.
 */
export interface EmployeeRow {
  id: string
  empCode: string
  firstNameTh: Buffer
  lastNameTh: Buffer
  firstNameEn: Buffer
  lastNameEn: Buffer
  nameZh: Buffer | null
  nationalId: Buffer
  nationalIdBidx: Buffer
  passportNo: Buffer | null
  taxId: Buffer
  ssoNumber: Buffer
  bankAccount: Buffer
  bankCode: string
  dob: Buffer
  address: Buffer
  phone: Buffer
  email: Buffer
  emailBidx: Buffer
  employmentType: EmploymentType
  orgUnitId: string
  positionId: string
  provinceCode: string
  startDate: string
  terminationDate: string | null
  status: EmployeeStatus
  preferredLang: Lang
  clockInMethod: ClockInMethod
  createdAt: string
  updatedAt: string
}

export interface NewEmployeeRow {
  /**
   * Client-generated (`randomUUID()` in `EmployeeService`), not left to the
   * column's `gen_random_uuid()` default. Every 🔐 field is encrypted with
   * AAD `entityId + ':' + fieldName` (roadmap "Data classification") BEFORE
   * this row is inserted — which requires knowing the employee's id before
   * the INSERT that would otherwise generate it. Postgres accepts an
   * explicit value for a column with a `DEFAULT` just fine; the default
   * only applies when the column is omitted.
   */
  id: string
  empCode: string
  firstNameTh: Buffer
  lastNameTh: Buffer
  firstNameEn: Buffer
  lastNameEn: Buffer
  nameZh: Buffer | null
  nationalId: Buffer
  nationalIdBidx: Buffer
  passportNo: Buffer | null
  taxId: Buffer
  ssoNumber: Buffer
  bankAccount: Buffer
  bankCode: string
  dob: Buffer
  address: Buffer
  phone: Buffer
  email: Buffer
  emailBidx: Buffer
  employmentType: EmploymentType
  orgUnitId: string
  positionId: string
  provinceCode: string
  startDate: string
  status: EmployeeStatus
  preferredLang: Lang
  clockInMethod: ClockInMethod
}

/** Every column an UPDATE may touch — all optional; `EmployeeRepository.update` only SETs what is present. */
export interface EmployeePatch {
  firstNameTh?: Buffer
  lastNameTh?: Buffer
  firstNameEn?: Buffer
  lastNameEn?: Buffer
  nameZh?: Buffer | null
  nationalId?: Buffer
  nationalIdBidx?: Buffer
  passportNo?: Buffer | null
  taxId?: Buffer
  ssoNumber?: Buffer
  bankAccount?: Buffer
  bankCode?: string
  dob?: Buffer
  address?: Buffer
  phone?: Buffer
  email?: Buffer
  emailBidx?: Buffer
  employmentType?: EmploymentType
  orgUnitId?: string
  positionId?: string
  provinceCode?: string
  startDate?: string
  terminationDate?: string | null
  status?: EmployeeStatus
  preferredLang?: Lang
  clockInMethod?: ClockInMethod
}

export interface EmployeeListFilter {
  orgUnitId?: string
  status?: EmployeeStatus
}

const SELECT_COLUMNS = `id, emp_code, first_name_th, last_name_th, first_name_en, last_name_en, name_zh,
  national_id, national_id_bidx, passport_no, tax_id, sso_number, bank_account, bank_code,
  dob, address, phone, email, email_bidx,
  employment_type, org_unit_id, position_id, province_code, start_date, termination_date,
  status, preferred_lang, clock_in_method, created_at, updated_at`

const INSERT_COLUMNS = `id, emp_code, first_name_th, last_name_th, first_name_en, last_name_en, name_zh,
  national_id, national_id_bidx, passport_no, tax_id, sso_number, bank_account, bank_code,
  dob, address, phone, email, email_bidx,
  employment_type, org_unit_id, position_id, province_code, start_date, status, preferred_lang, clock_in_method`

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`EmployeeRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

/** Postgres's `date` OID round-trips through `pg` as a local-time JS `Date` (well-known driver gotcha, same note as `svc-config`'s `rules.repository.ts`) — always re-derived as an ISO date string, never trusted as already being one. */
function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`EmployeeRepository: unexpected date value ${JSON.stringify(v)}`)
}
function toDateStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : toDateString(v)
}

function toBuffer(v: unknown, field: string): Buffer {
  if (Buffer.isBuffer(v)) return v
  throw new Error(`EmployeeRepository: expected ${field} to be a Buffer (bytea), got ${typeof v}`)
}
function toBufferOrNull(v: unknown, field: string): Buffer | null {
  return v === null || v === undefined ? null : toBuffer(v, field)
}

function mapRow(row: Record<string, unknown>): EmployeeRow {
  return {
    id: String(row['id']),
    empCode: String(row['emp_code']),
    firstNameTh: toBuffer(row['first_name_th'], 'first_name_th'),
    lastNameTh: toBuffer(row['last_name_th'], 'last_name_th'),
    firstNameEn: toBuffer(row['first_name_en'], 'first_name_en'),
    lastNameEn: toBuffer(row['last_name_en'], 'last_name_en'),
    nameZh: toBufferOrNull(row['name_zh'], 'name_zh'),
    nationalId: toBuffer(row['national_id'], 'national_id'),
    nationalIdBidx: toBuffer(row['national_id_bidx'], 'national_id_bidx'),
    passportNo: toBufferOrNull(row['passport_no'], 'passport_no'),
    taxId: toBuffer(row['tax_id'], 'tax_id'),
    ssoNumber: toBuffer(row['sso_number'], 'sso_number'),
    bankAccount: toBuffer(row['bank_account'], 'bank_account'),
    bankCode: String(row['bank_code']),
    dob: toBuffer(row['dob'], 'dob'),
    address: toBuffer(row['address'], 'address'),
    phone: toBuffer(row['phone'], 'phone'),
    email: toBuffer(row['email'], 'email'),
    emailBidx: toBuffer(row['email_bidx'], 'email_bidx'),
    employmentType: row['employment_type'] as EmploymentType,
    orgUnitId: String(row['org_unit_id']),
    positionId: String(row['position_id']),
    provinceCode: String(row['province_code']),
    startDate: toDateString(row['start_date']),
    terminationDate: toDateStringOrNull(row['termination_date']),
    status: row['status'] as EmployeeStatus,
    preferredLang: row['preferred_lang'] as Lang,
    clockInMethod: row['clock_in_method'] as ClockInMethod,
    createdAt: toIsoString(row['created_at']),
    updatedAt: toIsoString(row['updated_at']),
  }
}

/**
 * SQL only — no business logic (checksum validation, encryption, duplicate
 * checks) lives here; that is `employee.service.ts`'s job, matching
 * `services/svc-config`'s `service`/no-SQL split. Reads take a plain
 * `Queryable` (bound to the pool at construction); writes take the CALLER's
 * transaction handle `tx`, so a row and its `employee.*` outbox event
 * (`employee.service.ts`) commit or roll back together (kernel
 * `writeOutbox`, ADR-005).
 */
export class EmployeeRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<EmployeeRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM onboarding.employee WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** The read behind ONB-002's duplicate check — a match here (for a different employee than the one being updated, if any) means the national ID is already on file. */
  async findByNationalIdBidx(bidx: Buffer): Promise<EmployeeRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM onboarding.employee WHERE national_id_bidx = $1`, [bidx])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async list(filter: EmployeeListFilter): Promise<EmployeeRow[]> {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.orgUnitId !== undefined) {
      params.push(filter.orgUnitId)
      clauses.push(`org_unit_id = $${String(params.length)}`)
    }
    if (filter.status !== undefined) {
      params.push(filter.status)
      clauses.push(`status = $${String(params.length)}`)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM onboarding.employee ${where} ORDER BY created_at DESC`,
      params,
    )
    return rows.map(mapRow)
  }

  async insert(tx: Queryable, row: NewEmployeeRow): Promise<EmployeeRow> {
    const { rows } = await tx.query(
      `INSERT INTO onboarding.employee (${INSERT_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
       RETURNING ${SELECT_COLUMNS}`,
      [
        row.id, row.empCode, row.firstNameTh, row.lastNameTh, row.firstNameEn, row.lastNameEn, row.nameZh,
        row.nationalId, row.nationalIdBidx, row.passportNo, row.taxId, row.ssoNumber, row.bankAccount, row.bankCode,
        row.dob, row.address, row.phone, row.email, row.emailBidx,
        row.employmentType, row.orgUnitId, row.positionId, row.provinceCode, row.startDate, row.status, row.preferredLang, row.clockInMethod,
      ],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('EmployeeRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** No-op (returns `null`) if `id` does not exist or the patch is empty — the service turns "no such employee" into `ONB-003`. */
  async update(tx: Queryable, id: string, patch: EmployeePatch): Promise<EmployeeRow | null> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as Array<[keyof EmployeePatch, unknown]>
    if (entries.length === 0) return this.findByIdTx(tx, id)

    const columnFor: Record<keyof EmployeePatch, string> = {
      firstNameTh: 'first_name_th', lastNameTh: 'last_name_th', firstNameEn: 'first_name_en', lastNameEn: 'last_name_en',
      nameZh: 'name_zh', nationalId: 'national_id', nationalIdBidx: 'national_id_bidx', passportNo: 'passport_no',
      taxId: 'tax_id', ssoNumber: 'sso_number', bankAccount: 'bank_account', bankCode: 'bank_code',
      dob: 'dob', address: 'address', phone: 'phone', email: 'email', emailBidx: 'email_bidx',
      employmentType: 'employment_type', orgUnitId: 'org_unit_id', positionId: 'position_id', provinceCode: 'province_code',
      startDate: 'start_date', terminationDate: 'termination_date', status: 'status', preferredLang: 'preferred_lang',
      clockInMethod: 'clock_in_method',
    }

    const params: unknown[] = []
    const setClauses: string[] = []
    for (const [key, value] of entries) {
      params.push(value)
      setClauses.push(`${columnFor[key]} = $${String(params.length)}`)
    }
    setClauses.push('updated_at = now()')
    params.push(id)

    const { rows } = await tx.query(
      `UPDATE onboarding.employee SET ${setClauses.join(', ')} WHERE id = $${String(params.length)} RETURNING ${SELECT_COLUMNS}`,
      params,
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  private async findByIdTx(tx: Queryable, id: string): Promise<EmployeeRow | null> {
    const { rows } = await tx.query(`SELECT ${SELECT_COLUMNS} FROM onboarding.employee WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
