import { AuditEmitter, CryptoClient } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { belowMinimumWage, employeeRefNotFound, minimumWageNotOnFile, payProfileNotFound, providentFundRateOutOfBand } from './errors'
import { bahtToSatang, parsePercent, satangToBaht } from './money'
import type { Satang } from './money'
import { checkMinimumWage } from './engine/minimum-wage'
import type { PayBasis, TaxDeclaration } from './engine/types'
import { PayProfilesRepository } from './pay-profiles.repository'
import type { PayProfileRow, RecurringItem } from './pay-profiles.repository'
import { RefsRepository } from './refs.repository'
import { RULE_KEYS, StatutoryResolver, minimumWageRuleKey } from './statutory'
import type { ConfigClient } from './config-client'
import { decryptMoney, decryptText, encryptMoneyFields, encryptTextFields } from './money-crypto'

/**
 * M7-1 — pay structures. Monthly, daily and hourly bases; recurring and
 * one-off earnings and deductions; and the minimum-wage floor validated
 * against THE EMPLOYEE'S PROVINCE.
 *
 * The floor check happens on WRITE as well as inside the engine on
 * calculate. Both are deliberate. Rejecting a sub-minimum wage at the
 * moment an HR officer types it is the interaction that actually prevents
 * the offence; re-checking at calculate time catches the case the write
 * check cannot see — a Wage Committee notification raising the floor
 * between the profile being saved and the payroll being run, which is
 * precisely how a compliant employer becomes non-compliant without doing
 * anything.
 *
 * The rejection carries the province, the floor and the CITATION, all from
 * `svc-config`. An HR officer who cannot see which notification blocked
 * them will just try again with a different number.
 */

export interface PayProfileInputDto {
  basePayThb: string
  payBasis: PayBasis
  recurringItems: RecurringItem[]
  pfRatePercent: string | null
  pfRateEmployerPercent: string | null
  declaration: TaxDeclaration | null
  bankCode: string | null
  bankAccount: string | null
  bankAccountName: string | null
}

/** The plaintext view of a profile, returned only to callers holding `payroll.profile.read`; every read of it is an audited S3 read. */
export interface PayProfileView {
  employeeId: string
  basePayThb: string
  payBasis: PayBasis
  recurringItems: RecurringItem[]
  pfRatePercent: string | null
  pfRateEmployerPercent: string | null
  declaration: TaxDeclaration | null
  bankCode: string | null
  bankAccountMasked: string | null
}

/** Everything the engine needs from a profile, decrypted once per run. */
export interface DecryptedProfile {
  employeeId: string
  basis: PayBasis
  basePay: Satang
  pfRatePercent: string | null
  pfRateEmployerPercent: string | null
  declaration: TaxDeclaration | null
  recurringItems: RecurringItem[]
  bankCode: string | null
  bankAccount: string | null
  bankAccountName: string | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Parses the stored ล.ย.01 declaration blob. A malformed blob is treated as "no declaration" — the engine then withholds on the personal allowance alone and flags the payslip (PAY-040), which is safer than failing the whole run. */
export function parseDeclaration(json: string): TaxDeclaration | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const num = (key: string): number => {
    const v = parsed[key]
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
  }
  const other = parsed['otherAllowancesThb']
  return {
    spouse: parsed['spouse'] === true,
    children: num('children'),
    childrenSecondFrom2018: num('childrenSecondFrom2018'),
    parentsCaredFor: num('parentsCaredFor'),
    otherAllowances: typeof other === 'string' ? bahtToSatang(other) : 0n,
  }
}

export function serialiseDeclaration(declaration: TaxDeclaration): string {
  return JSON.stringify({
    spouse: declaration.spouse,
    children: declaration.children,
    childrenSecondFrom2018: declaration.childrenSecondFrom2018,
    parentsCaredFor: declaration.parentsCaredFor,
    otherAllowancesThb: satangToBaht(declaration.otherAllowances),
  })
}

/** Last four digits only. A bank account is S3; the profile screen shows enough to confirm the right account without re-exposing it on every page load. */
function maskAccount(account: string): string {
  const digits = account.replace(/\s+/g, '')
  return digits.length <= 4 ? '*'.repeat(digits.length) : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`
}

export class PayProfilesService {
  constructor(
    private readonly repo: PayProfilesRepository,
    private readonly refs: RefsRepository,
    private readonly crypto: CryptoClient,
    private readonly config: ConfigClient,
    private readonly newId: () => string,
    private readonly audit: AuditEmitter = new AuditEmitter(),
  ) {}

  /**
   * Creates or replaces a profile. `on` is the date the statutory figures
   * are validated against — today for an ordinary edit. `actorId`/`actorRole`
   * default to `'unknown'` so every existing caller (tests, `FinalPayService`
   * indirectly) keeps compiling — an imprecise actor on the audit entry
   * beats every write path having to be touched to supply one.
   */
  async upsert(
    tx: Queryable,
    employeeId: string,
    dto: PayProfileInputDto,
    on: string,
    actorId = 'unknown',
    actorRole = 'unknown',
  ): Promise<PayProfileView> {
    const employee = await this.refs.findEmployee(employeeId, tx)
    if (employee === null) throw employeeRefNotFound(employeeId)

    const basePay = bahtToSatang(dto.basePayThb)
    const resolver = new StatutoryResolver(this.config, on)

    await this.assertAboveMinimumWage(resolver, dto.payBasis, basePay, employee.provinceCode)
    await this.assertProvidentFundRateInBand(resolver, dto.pfRatePercent)
    await this.assertProvidentFundRateInBand(resolver, dto.pfRateEmployerPercent)

    const existing = await this.repo.findByEmployee(employeeId, tx)
    const id = existing?.id ?? this.newId()

    // Everything sensitive is encrypted BEFORE the write, in one batch —
    // the database never receives a plaintext salary, PF rate, tax
    // declaration or bank account.
    const money = await encryptMoneyFields(this.crypto, id, { base_pay: basePay })
    const texts: Record<string, string> = {}
    if (dto.pfRatePercent !== null) texts['pf_rate'] = dto.pfRatePercent
    if (dto.pfRateEmployerPercent !== null) texts['pf_rate_employer'] = dto.pfRateEmployerPercent
    if (dto.declaration !== null) texts['tax_allowance_decl'] = serialiseDeclaration(dto.declaration)
    if (dto.bankAccount !== null) texts['bank_account'] = dto.bankAccount
    if (dto.bankAccountName !== null) texts['bank_account_name'] = dto.bankAccountName
    const encryptedTexts = await encryptTextFields(this.crypto, id, texts)

    const basePayCipher = money.get('base_pay')
    if (basePayCipher === undefined) throw new Error('PayProfilesService: svc-crypto did not return base_pay ciphertext')

    const row = {
      id,
      employeeId,
      basePay: basePayCipher,
      payBasis: dto.payBasis,
      recurringItems: dto.recurringItems,
      pfRate: encryptedTexts.get('pf_rate') ?? null,
      pfRateEmployer: encryptedTexts.get('pf_rate_employer') ?? null,
      taxAllowanceDecl: encryptedTexts.get('tax_allowance_decl') ?? null,
      bankCode: dto.bankCode,
      bankAccount: encryptedTexts.get('bank_account') ?? null,
      bankAccountName: encryptedTexts.get('bank_account_name') ?? null,
    }

    const saved = existing === null ? await this.repo.insert(tx, row) : await this.repo.update(tx, row)
    if (saved === null) throw payProfileNotFound(employeeId)

    // "pay-profile reads and writes (S3 → purpose required)" — roadmap
    // audit-coverage brief. `after` never carries `basePayThb` or any other
    // money/bank field raw — only the shape (basis, whether recurring items
    // exist) — `AuditEmitter.emit` would hash it before the outbox either
    // way, but keeping the object itself free of S3 values is the same
    // belt-and-suspenders discipline `employee.service.ts` documents for
    // `employee.created`'s `after`.
    await this.audit.emit(tx, 'payroll', {
      actorId,
      actorRole,
      action: existing === null ? 'pay_profile.created' : 'pay_profile.updated',
      entity: 'pay_profile',
      entityId: employeeId,
      after: { payBasis: dto.payBasis, recurringItemCount: dto.recurringItems.length },
    })

    return {
      employeeId,
      basePayThb: satangToBaht(basePay),
      payBasis: dto.payBasis,
      recurringItems: dto.recurringItems,
      pfRatePercent: dto.pfRatePercent,
      pfRateEmployerPercent: dto.pfRateEmployerPercent,
      declaration: dto.declaration,
      bankCode: dto.bankCode,
      bankAccountMasked: dto.bankAccount === null ? null : maskAccount(dto.bankAccount),
    }
  }

  /**
   * `GET /profiles/:employeeId` is an audited S3 read (roadmap: "pay-profile
   * reads ... purpose required"). `view()` itself stays DB-write-free (it
   * only decrypts) so the slow crypto round trips it makes don't hold a
   * transaction open; this commits the audit entry separately, the same
   * split `employee.controller.ts`'s `prepareSensitiveRead`/
   * `commitSensitiveReadAudit` pair uses. Action ends in
   * `.sensitive.read` so kernel `AuditEmitter.emit` itself rejects a blank
   * purpose — the enforcement does not depend on this method remembering to
   * check.
   */
  async commitProfileReadAudit(tx: Queryable, employeeId: string, purpose: string, actorId: string, actorRole: string): Promise<void> {
    await this.audit.emit(tx, 'payroll', {
      actorId,
      actorRole,
      action: 'pay_profile.sensitive.read',
      entity: 'pay_profile',
      entityId: employeeId,
      purpose,
    })
  }

  async view(employeeId: string, purpose: string): Promise<PayProfileView> {
    const decrypted = await this.decrypt(employeeId, purpose)
    return {
      employeeId,
      basePayThb: satangToBaht(decrypted.basePay),
      payBasis: decrypted.basis,
      recurringItems: decrypted.recurringItems,
      pfRatePercent: decrypted.pfRatePercent,
      pfRateEmployerPercent: decrypted.pfRateEmployerPercent,
      declaration: decrypted.declaration,
      bankCode: decrypted.bankCode,
      bankAccountMasked: decrypted.bankAccount === null ? null : maskAccount(decrypted.bankAccount),
    }
  }

  /** Decrypts one profile for the engine. `purpose` reaches the audit log; the kernel client rejects a blank one. */
  async decrypt(employeeId: string, purpose: string, db?: Queryable): Promise<DecryptedProfile> {
    const row = await this.repo.findByEmployee(employeeId, db)
    if (row === null) throw payProfileNotFound(employeeId)
    return this.decryptRow(row, purpose)
  }

  async decryptRow(row: PayProfileRow, purpose: string): Promise<DecryptedProfile> {
    const basePay = await decryptMoney(this.crypto, row.id, 'base_pay', row.basePay, purpose)
    const pfRatePercent = row.pfRate === null ? null : await decryptText(this.crypto, row.id, 'pf_rate', row.pfRate, purpose)
    const pfRateEmployerPercent =
      row.pfRateEmployer === null ? null : await decryptText(this.crypto, row.id, 'pf_rate_employer', row.pfRateEmployer, purpose)
    const declarationJson =
      row.taxAllowanceDecl === null ? null : await decryptText(this.crypto, row.id, 'tax_allowance_decl', row.taxAllowanceDecl, purpose)
    const bankAccount = row.bankAccount === null ? null : await decryptText(this.crypto, row.id, 'bank_account', row.bankAccount, purpose)
    const bankAccountName =
      row.bankAccountName === null ? null : await decryptText(this.crypto, row.id, 'bank_account_name', row.bankAccountName, purpose)

    return {
      employeeId: row.employeeId,
      basis: row.payBasis,
      basePay,
      pfRatePercent,
      pfRateEmployerPercent,
      declaration: declarationJson === null ? null : parseDeclaration(declarationJson),
      recurringItems: row.recurringItems,
      bankCode: row.bankCode,
      bankAccount,
      bankAccountName,
    }
  }

  private async assertAboveMinimumWage(
    resolver: StatutoryResolver,
    basis: PayBasis,
    basePay: Satang,
    provinceCode: string | null,
  ): Promise<void> {
    // A profile with no province at all cannot be floor-checked here; the
    // employee ref is populated from `employee.created`/`updated`, and
    // `refs.repository.ts` deliberately refuses to overwrite a known
    // province with null. The engine re-checks at calculate time, where the
    // province IS required.
    if (provinceCode === null) return
    const floor = await resolver.optionalMoney(minimumWageRuleKey(provinceCode))
    // FAILS CLOSED (2026-08-04) — see `minimumWageNotOnFile`. Accepting a
    // base pay we cannot check against any floor is how an unverified wage
    // reaches a payslip looking checked.
    if (floor === null) throw minimumWageNotOnFile(provinceCode, minimumWageRuleKey(provinceCode))
    const [divisor, hoursPerDay] = await Promise.all([
      resolver.requiredCount(RULE_KEYS.minWageMonthlyDivisor),
      resolver.requiredCount(RULE_KEYS.otHourlyBaseHours),
    ])
    const outcome = checkMinimumWage(basis, basePay, floor.value, divisor.value, hoursPerDay.value)
    if (!outcome.ok) {
      throw belowMinimumWage(provinceCode, satangToBaht(outcome.dailyEquivalent), satangToBaht(outcome.floor), floor.citation)
    }
  }

  private async assertProvidentFundRateInBand(resolver: StatutoryResolver, ratePercent: string | null): Promise<void> {
    if (ratePercent === null) return
    const rate = parsePercent(ratePercent)
    const [min, max] = await Promise.all([
      resolver.requiredPercent(RULE_KEYS.pfRateMin),
      resolver.requiredPercent(RULE_KEYS.pfRateMax),
    ])
    const aboveMin = rate.num * min.value.den >= min.value.num * rate.den
    const belowMax = rate.num * max.value.den <= max.value.num * rate.den
    if (!aboveMin || !belowMax) {
      throw providentFundRateOutOfBand(
        ratePercent,
        `${min.value.num.toString()}/${min.value.den.toString()}`,
        `${max.value.num.toString()}/${max.value.den.toString()}`,
        min.citation,
      )
    }
  }
}
