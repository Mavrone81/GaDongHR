import { randomUUID } from 'node:crypto'
import { AuditEmitter, CryptoClient, isBlankPurpose, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { EmployeeRepository } from './employee.repository'
import type { ClockInMethod, EmployeePatch, EmployeeRow, EmploymentType, Lang, NewEmployeeRow, EmployeeStatus } from './employee.repository'
import { ChecklistService } from './checklist.service'
import { ProbationRepository } from './probation.repository'
import type { TaskKey } from './onboarding-task.repository'
import { isValidThaiNationalId } from './national-id'
import {
  duplicateNationalId,
  employeeNotFound,
  invalidNationalId,
  lifecycleGuardFailed,
  purposeRequired,
  terminationReasonRequired,
  unknownSensitiveField,
} from './onboarding-errors'

export interface ThaiAddress {
  houseNo: string
  subDistrict: string
  district: string
  province: string
  postalCode: string
}

export interface CreateEmployeeInput {
  empCode: string
  firstNameTh: string
  lastNameTh: string
  firstNameEn: string
  lastNameEn: string
  nameZh?: string
  nationalId: string
  passportNo?: string
  taxId: string
  /** Optional — blank (`''`) means "not yet registered with SSO"; `ChecklistService.completeTask` blocks the `sso_registration` task until this is a real value (ONB-030). */
  ssoNumber?: string
  bankAccount: string
  bankCode: string
  dob: string
  address: ThaiAddress
  phone: string
  email: string
  employmentType: EmploymentType
  orgUnitId: string
  positionId: string
  provinceCode: string
  startDate: string
  preferredLang: Lang
  /** If given, opens a `Probation` record with this end date (PRD M1-1: "probation end date" is a field HR sets, not a computed statutory figure). */
  probationEndDate?: string
}

export interface EmployeeProfile {
  id: string
  empCode: string
  firstNameTh: string
  lastNameTh: string
  firstNameEn: string
  lastNameEn: string
  nameZh: string | null
  dob: string
  address: ThaiAddress
  phone: string
  email: string
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

export interface EmployeeSummary {
  id: string
  empCode: string
  employmentType: EmploymentType
  orgUnitId: string
  positionId: string
  provinceCode: string
  startDate: string
  status: EmployeeStatus
  preferredLang: Lang
}

export interface EmployeeListFilter {
  orgUnitId?: string
  status?: EmployeeStatus
}

/** The purpose recorded for every routine S2 profile decrypt — distinct from the caller-supplied, mandatory purpose on `GET /employees/:id/sensitive` (M1-1 AC #4), because a basic profile view is not the audited-S3-read path. */
const PROFILE_READ_PURPOSE = 'employee.profile.read'

/** Every field name `GET /employees/:id/sensitive?fields=` may name — snake_case, matching the API example (`fields=national_id,bank_account`) and the exact string used as the crypto AAD field component at both encrypt and decrypt time. */
const SENSITIVE_FIELD_NAMES = new Set([
  'first_name_th', 'last_name_th', 'first_name_en', 'last_name_en', 'name_zh',
  'national_id', 'passport_no', 'tax_id', 'sso_number', 'bank_account',
  'dob', 'address', 'phone', 'email',
])

const ALLOWED_TRANSITIONS: Record<EmployeeStatus, EmployeeStatus[]> = {
  draft: ['onboarding', 'cancelled'],
  onboarding: ['active', 'cancelled'],
  active: ['terminated'],
  cancelled: [],
  terminated: [],
}

export interface PreparedEmployeeCreate {
  newRow: NewEmployeeRow
  checklistPlan: Array<{ taskKey: TaskKey; dueDate: string }>
  probationEndDate: string | undefined
}

export interface PreparedEmployeeUpdate {
  id: string
  patch: EmployeePatch
}

function toEmployeeSummary(row: EmployeeRow): EmployeeSummary {
  return {
    id: row.id,
    empCode: row.empCode,
    employmentType: row.employmentType,
    orgUnitId: row.orgUnitId,
    positionId: row.positionId,
    provinceCode: row.provinceCode,
    startDate: row.startDate,
    status: row.status,
    preferredLang: row.preferredLang,
  }
}

/**
 * Business logic behind `/employees*` (M1-ONBOARDING §3.1, rows 1-6). No
 * SQL here (`employee.repository.ts` owns that), matching
 * `services/svc-config`'s `service`/no-SQL split.
 *
 * Every write path follows `svc-docs`'s `prepare()`/`commit()` split: the
 * slow, external I/O (Thai-ID checksum validation is local and cheap, but
 * `CryptoClient.encryptBatch`/`blindIndex` are real network calls to
 * svc-crypto) happens in `prepare*`, BEFORE any database transaction opens;
 * `commit*` is the fast, pure-DB write (insert/update + checklist rows +
 * outbox event), taking the caller's transaction handle `tx` so the row and
 * its `employee.*` event commit or roll back together (ADR-005). This
 * ordering is also what makes "crypto unavailable ⇒ no row written" true
 * for free: a `CryptoClient` failure throws before `commit*` — and
 * therefore before any `INSERT`/`UPDATE` — is ever reached.
 */
export class EmployeeService {
  constructor(
    private readonly repo: EmployeeRepository,
    private readonly crypto: CryptoClient,
    private readonly checklist: ChecklistService,
    private readonly probationRepo: ProbationRepository,
    private readonly audit: AuditEmitter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private today(): string {
    return this.now().toISOString().slice(0, 10)
  }

  // --- create ---

  async prepareCreate(input: CreateEmployeeInput): Promise<PreparedEmployeeCreate> {
    if (!isValidThaiNationalId(input.nationalId)) throw invalidNationalId()

    const id = randomUUID()

    const s2: Array<[string, string | undefined]> = [
      ['first_name_th', input.firstNameTh],
      ['last_name_th', input.lastNameTh],
      ['first_name_en', input.firstNameEn],
      ['last_name_en', input.lastNameEn],
      ['name_zh', input.nameZh],
      ['dob', input.dob],
      ['address', JSON.stringify(input.address)],
      ['phone', input.phone],
      ['email', input.email],
    ]
    const s3: Array<[string, string | undefined]> = [
      ['national_id', input.nationalId],
      ['passport_no', input.passportNo],
      ['tax_id', input.taxId],
      ['sso_number', input.ssoNumber ?? ''],
      ['bank_account', input.bankAccount],
    ]

    const requests = [
      ...s2.filter((e): e is [string, string] => e[1] !== undefined).map(([field, value]) => ({ entityId: id, field, value, fieldClass: 'S2' as const })),
      ...s3.filter((e): e is [string, string] => e[1] !== undefined).map(([field, value]) => ({ entityId: id, field, value, fieldClass: 'S3' as const })),
    ]
    // Fails closed with CRY-503 on any transport/format problem (kernel
    // CryptoClient's own contract) — thrown here, before any DB write.
    const ciphertexts = await this.crypto.encryptBatch(requests)

    const nationalIdBidx = await this.crypto.blindIndex('S3', 'national_id', input.nationalId)
    const emailBidx = await this.crypto.blindIndex('S2', 'email', input.email)

    // Pre-check (fast-fail, nice error before opening a transaction) — the
    // DB's UNIQUE constraint on national_id_bidx is the actual enforcement
    // mechanism (belt-and-braces, matching svc-config's SoD check).
    const existing = await this.repo.findByNationalIdBidx(nationalIdBidx)
    if (existing) throw duplicateNationalId()

    const ssoDeadlineDays = await this.checklist.resolveSsoDeadlineDays()
    const checklistPlan = this.checklist.planTasks(input.employmentType, input.startDate, ssoDeadlineDays)

    const newRow: NewEmployeeRow = {
      id,
      empCode: input.empCode,
      firstNameTh: mustGet(ciphertexts, 'first_name_th'),
      lastNameTh: mustGet(ciphertexts, 'last_name_th'),
      firstNameEn: mustGet(ciphertexts, 'first_name_en'),
      lastNameEn: mustGet(ciphertexts, 'last_name_en'),
      nameZh: ciphertexts.get('name_zh') ?? null,
      nationalId: mustGet(ciphertexts, 'national_id'),
      nationalIdBidx,
      passportNo: ciphertexts.get('passport_no') ?? null,
      taxId: mustGet(ciphertexts, 'tax_id'),
      ssoNumber: mustGet(ciphertexts, 'sso_number'),
      bankAccount: mustGet(ciphertexts, 'bank_account'),
      bankCode: input.bankCode,
      dob: mustGet(ciphertexts, 'dob'),
      address: mustGet(ciphertexts, 'address'),
      phone: mustGet(ciphertexts, 'phone'),
      email: mustGet(ciphertexts, 'email'),
      emailBidx,
      employmentType: input.employmentType,
      orgUnitId: input.orgUnitId,
      positionId: input.positionId,
      provinceCode: input.provinceCode,
      startDate: input.startDate,
      status: 'draft',
      preferredLang: input.preferredLang,
      clockInMethod: 'biometric',
    }

    return { newRow, checklistPlan, probationEndDate: input.probationEndDate }
  }

  async commitCreate(tx: Queryable, prepared: PreparedEmployeeCreate, actorId: string, actorRole: string): Promise<{ id: string; empCode: string }> {
    const row = await this.repo.insert(tx, prepared.newRow)
    await this.checklist.createTasks(tx, row.id, prepared.checklistPlan)
    if (prepared.probationEndDate) {
      await this.probationRepo.insert(tx, row.id, prepared.probationEndDate)
    }

    await writeOutbox(tx, 'onboarding', 'employee.created', employeeEventPayload(row))
    await this.audit.emit(tx, 'onboarding', {
      actorId, actorRole, action: 'employee.created', entity: 'employee', entityId: row.id, after: { empCode: row.empCode, status: row.status },
    })

    return { id: row.id, empCode: row.empCode }
  }

  // --- read ---

  async getProfile(id: string): Promise<EmployeeProfile> {
    const row = await this.repo.findById(id)
    if (!row) throw employeeNotFound(id)

    const [firstNameTh, lastNameTh, firstNameEn, lastNameEn, dob, addressJson, phone, email] = await Promise.all([
      this.crypto.decrypt(id, 'first_name_th', row.firstNameTh, PROFILE_READ_PURPOSE),
      this.crypto.decrypt(id, 'last_name_th', row.lastNameTh, PROFILE_READ_PURPOSE),
      this.crypto.decrypt(id, 'first_name_en', row.firstNameEn, PROFILE_READ_PURPOSE),
      this.crypto.decrypt(id, 'last_name_en', row.lastNameEn, PROFILE_READ_PURPOSE),
      this.crypto.decrypt(id, 'dob', row.dob, PROFILE_READ_PURPOSE),
      this.crypto.decrypt(id, 'address', row.address, PROFILE_READ_PURPOSE),
      this.crypto.decrypt(id, 'phone', row.phone, PROFILE_READ_PURPOSE),
      this.crypto.decrypt(id, 'email', row.email, PROFILE_READ_PURPOSE),
    ])
    const nameZh = row.nameZh ? await this.crypto.decrypt(id, 'name_zh', row.nameZh, PROFILE_READ_PURPOSE) : null

    return {
      id: row.id, empCode: row.empCode,
      firstNameTh, lastNameTh, firstNameEn, lastNameEn, nameZh,
      dob, address: JSON.parse(addressJson) as ThaiAddress, phone, email,
      employmentType: row.employmentType, orgUnitId: row.orgUnitId, positionId: row.positionId, provinceCode: row.provinceCode,
      startDate: row.startDate, terminationDate: row.terminationDate, status: row.status, preferredLang: row.preferredLang,
      clockInMethod: row.clockInMethod, createdAt: row.createdAt, updatedAt: row.updatedAt,
    }
  }

  /** `GET /employees?org_unit&status` — no S3 (or S2) decryption at all, deliberately: a list view over potentially many rows must not fan out into one crypto round trip per field per row. */
  async list(filter: EmployeeListFilter): Promise<EmployeeSummary[]> {
    const rows = await this.repo.list(filter)
    return rows.map(toEmployeeSummary)
  }

  // --- GET /employees/:id/sensitive ---

  /** External I/O only (decrypt calls) — no DB write. Purpose validated first (ONB-021), same "blank" definition kernel's `AuditEmitter` uses. */
  async prepareSensitiveRead(id: string, fields: string[], purpose: string): Promise<Record<string, string | null>> {
    if (isBlankPurpose(purpose)) throw purposeRequired()
    for (const f of fields) if (!SENSITIVE_FIELD_NAMES.has(f)) throw unknownSensitiveField(f)

    const row = await this.repo.findById(id)
    if (!row) throw employeeNotFound(id)

    const values: Record<string, string | null> = {}
    for (const field of fields) {
      const ciphertext = ciphertextFor(row, field)
      values[field] = ciphertext ? await this.crypto.decrypt(id, field, ciphertext, purpose) : null
    }
    return values
  }

  /**
   * Exactly one `audit.employee.sensitive.read` entry per requested field
   * (M1-1 AC), regardless of whether that field happened to have a value —
   * a null-valued field was still accessed. `entity` carries which FIELD
   * this entry is about (`employee.national_id`, not just `employee`) —
   * `entityId` stays the real employee id (so every entry for one
   * sensitive-read call still correlates to the same subject) rather than
   * being overloaded to also encode the field. Kernel's `AuditEmitter`
   * hashes `before`/`after` before they ever reach the outbox (roadmap
   * "Audit payloads must carry hashes, not values"), so the field name
   * cannot ride in `after` either — it would only survive as an opaque
   * hash, unusable for a human or a compliance report to read.
   */
  async commitSensitiveReadAudit(tx: Queryable, id: string, fields: string[], purpose: string, actorId: string, actorRole: string): Promise<void> {
    for (const field of fields) {
      await this.audit.emit(tx, 'onboarding', {
        actorId, actorRole, action: 'employee.sensitive.read', entity: `employee.${field}`, entityId: id, purpose,
      })
    }
  }

  // --- update ---

  async prepareUpdate(id: string, patch: Partial<CreateEmployeeInput>): Promise<PreparedEmployeeUpdate> {
    const existing = await this.repo.findById(id)
    if (!existing) throw employeeNotFound(id)

    if (patch.nationalId !== undefined && !isValidThaiNationalId(patch.nationalId)) throw invalidNationalId()

    const encryptable: Array<[string, string | undefined, 'S2' | 'S3']> = [
      ['first_name_th', patch.firstNameTh, 'S2'], ['last_name_th', patch.lastNameTh, 'S2'],
      ['first_name_en', patch.firstNameEn, 'S2'], ['last_name_en', patch.lastNameEn, 'S2'],
      ['name_zh', patch.nameZh, 'S2'], ['dob', patch.dob, 'S2'],
      ['address', patch.address ? JSON.stringify(patch.address) : undefined, 'S2'],
      ['phone', patch.phone, 'S2'], ['email', patch.email, 'S2'],
      ['national_id', patch.nationalId, 'S3'], ['passport_no', patch.passportNo, 'S3'],
      ['tax_id', patch.taxId, 'S3'], ['sso_number', patch.ssoNumber, 'S3'], ['bank_account', patch.bankAccount, 'S3'],
    ]
    const requests = encryptable
      .filter((e): e is [string, string, 'S2' | 'S3'] => e[1] !== undefined)
      .map(([field, value, fieldClass]) => ({ entityId: id, field, value, fieldClass }))
    const ciphertexts = requests.length > 0 ? await this.crypto.encryptBatch(requests) : new Map<string, Buffer>()

    const employeePatch: EmployeePatch = {}
    if (ciphertexts.has('first_name_th')) employeePatch.firstNameTh = ciphertexts.get('first_name_th')
    if (ciphertexts.has('last_name_th')) employeePatch.lastNameTh = ciphertexts.get('last_name_th')
    if (ciphertexts.has('first_name_en')) employeePatch.firstNameEn = ciphertexts.get('first_name_en')
    if (ciphertexts.has('last_name_en')) employeePatch.lastNameEn = ciphertexts.get('last_name_en')
    if (ciphertexts.has('name_zh')) employeePatch.nameZh = ciphertexts.get('name_zh') ?? null
    if (ciphertexts.has('dob')) employeePatch.dob = ciphertexts.get('dob')
    if (ciphertexts.has('address')) employeePatch.address = ciphertexts.get('address')
    if (ciphertexts.has('phone')) employeePatch.phone = ciphertexts.get('phone')
    if (ciphertexts.has('email')) {
      employeePatch.email = ciphertexts.get('email')
      employeePatch.emailBidx = await this.crypto.blindIndex('S2', 'email', patch.email!)
    }
    if (ciphertexts.has('passport_no')) employeePatch.passportNo = ciphertexts.get('passport_no') ?? null
    if (ciphertexts.has('tax_id')) employeePatch.taxId = ciphertexts.get('tax_id')
    if (ciphertexts.has('sso_number')) employeePatch.ssoNumber = ciphertexts.get('sso_number')
    if (ciphertexts.has('bank_account')) employeePatch.bankAccount = ciphertexts.get('bank_account')

    if (ciphertexts.has('national_id')) {
      const nationalIdBidx = await this.crypto.blindIndex('S3', 'national_id', patch.nationalId!)
      const collision = await this.repo.findByNationalIdBidx(nationalIdBidx)
      if (collision && collision.id !== id) throw duplicateNationalId()
      employeePatch.nationalId = ciphertexts.get('national_id')
      employeePatch.nationalIdBidx = nationalIdBidx
    }

    if (patch.bankCode !== undefined) employeePatch.bankCode = patch.bankCode
    if (patch.employmentType !== undefined) employeePatch.employmentType = patch.employmentType
    if (patch.orgUnitId !== undefined) employeePatch.orgUnitId = patch.orgUnitId
    if (patch.positionId !== undefined) employeePatch.positionId = patch.positionId
    if (patch.provinceCode !== undefined) employeePatch.provinceCode = patch.provinceCode
    if (patch.startDate !== undefined) employeePatch.startDate = patch.startDate
    if (patch.preferredLang !== undefined) employeePatch.preferredLang = patch.preferredLang

    return { id, patch: employeePatch }
  }

  async commitUpdate(tx: Queryable, prepared: PreparedEmployeeUpdate, actorId: string, actorRole: string): Promise<{ id: string; empCode: string }> {
    const row = await this.repo.update(tx, prepared.id, prepared.patch)
    if (!row) throw employeeNotFound(prepared.id)

    await writeOutbox(tx, 'onboarding', 'employee.updated', employeeEventPayload(row))
    await this.audit.emit(tx, 'onboarding', {
      actorId, actorRole, action: 'employee.updated', entity: 'employee', entityId: row.id, after: { status: row.status },
    })

    return { id: row.id, empCode: row.empCode }
  }

  // --- transition (POST /employees/:id/transition) ---

  async transition(tx: Queryable, id: string, to: EmployeeStatus, reason: string | undefined, actorId: string, actorRole: string): Promise<{ id: string; status: EmployeeStatus }> {
    const existing = await this.repo.findById(id)
    if (!existing) throw employeeNotFound(id)

    if (!ALLOWED_TRANSITIONS[existing.status].includes(to)) {
      throw lifecycleGuardFailed(`cannot transition from "${existing.status}" to "${to}"`)
    }
    if (to === 'active') {
      const complete = await this.checklist.allComplete(id)
      if (!complete) throw lifecycleGuardFailed('onboarding checklist is not complete')
    }
    if (to === 'terminated' && (reason === undefined || reason.trim().length === 0)) {
      throw terminationReasonRequired()
    }

    const patch: EmployeePatch = { status: to }
    if (to === 'terminated') patch.terminationDate = this.today()
    const row = await this.repo.update(tx, id, patch)
    if (!row) throw employeeNotFound(id)

    if (to === 'terminated') {
      await writeOutbox(tx, 'onboarding', 'employee.terminated', { id: row.id, terminationDate: row.terminationDate, reasonCategory: reason })
      await this.audit.emit(tx, 'onboarding', { actorId, actorRole, action: 'employee.terminated', entity: 'employee', entityId: row.id, after: { reasonCategory: reason } })
    } else {
      await writeOutbox(tx, 'onboarding', 'employee.updated', employeeEventPayload(row))
      await this.audit.emit(tx, 'onboarding', { actorId, actorRole, action: 'employee.updated', entity: 'employee', entityId: row.id, after: { status: row.status } })
    }

    return { id: row.id, status: row.status }
  }

  /** Used by `ProbationService`'s `terminate` outcome — same guard/side-effects as `transition(..., 'terminated', ...)`, but callable from within a probation decision's own transaction without going through the public transition endpoint's re-validation of an already-decided probation. */
  async terminateWithinTx(tx: Queryable, id: string, reason: string, actorId: string, actorRole: string): Promise<void> {
    await this.transition(tx, id, 'terminated', reason, actorId, actorRole)
  }

  /** Used by `ConsentService` to flip the (non-adverse) clock-in routing flag on a biometric refusal/withdrawal, and by a re-grant to flip it back. */
  async setClockInMethod(tx: Queryable, id: string, method: ClockInMethod): Promise<void> {
    const row = await this.repo.update(tx, id, { clockInMethod: method })
    if (!row) throw employeeNotFound(id)
  }

  /** Used by `ChecklistService.completeTask`'s caller to decide `ssoNumberPresent` — only `EmployeeService` can decrypt. */
  async hasSsoNumber(id: string): Promise<boolean> {
    const row = await this.repo.findById(id)
    if (!row) throw employeeNotFound(id)
    const value = await this.crypto.decrypt(id, 'sso_number', row.ssoNumber, 'onboarding.checklist.sso_check')
    return value.trim().length > 0
  }

  async findRawById(id: string): Promise<EmployeeRow | null> {
    return this.repo.findById(id)
  }
}

function mustGet(m: Map<string, Buffer>, field: string): Buffer {
  const v = m.get(field)
  if (!v) throw new Error(`EmployeeService: encryptBatch did not return ciphertext for required field "${field}"`)
  return v
}

function ciphertextFor(row: EmployeeRow, field: string): Buffer | null {
  switch (field) {
    case 'first_name_th': return row.firstNameTh
    case 'last_name_th': return row.lastNameTh
    case 'first_name_en': return row.firstNameEn
    case 'last_name_en': return row.lastNameEn
    case 'name_zh': return row.nameZh
    case 'national_id': return row.nationalId
    case 'passport_no': return row.passportNo
    case 'tax_id': return row.taxId
    case 'sso_number': return row.ssoNumber
    case 'bank_account': return row.bankAccount
    case 'dob': return row.dob
    case 'address': return row.address
    case 'phone': return row.phone
    case 'email': return row.email
    default:
      throw unknownSensitiveField(field)
  }
}

/** Exactly the `employee.created`/`employee.updated` payload shape the roadmap's event catalog pins — no S3 plaintext, ever. */
function employeeEventPayload(row: EmployeeRow): Record<string, unknown> {
  return {
    id: row.id,
    empCode: row.empCode,
    orgUnitId: row.orgUnitId,
    employmentType: row.employmentType,
    provinceCode: row.provinceCode,
    startDate: row.startDate,
    status: row.status,
    preferredLang: row.preferredLang,
  }
}
