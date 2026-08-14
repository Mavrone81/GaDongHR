import { AuditEmitter, CryptoClient } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { bankAccountMissing, exportBeforeCommit, runNotFound } from './errors'
import type { Satang } from './money'
import { RULE_KEYS, StatutoryResolver } from './statutory'
import type { ConfigClient } from './config-client'
import { PayProfilesRepository } from './pay-profiles.repository'
import { PayProfilesService } from './pay-profiles.service'
import { PayslipsRepository } from './payslips.repository'
import { RefsRepository } from './refs.repository'
import { RunsRepository } from './runs.repository'
import { ExportsRepository } from './exports.repository'
import type { PayrollRunRow } from './runs.repository'
import { BANK_FORMATS, buildBankFile } from './bank-files'
import type { BankFileResult, BankTransferLine } from './bank-files'
import { EXPORT_BUILDERS } from './statutory-exports'
import type { ExportContext, ExportEmployeeLine, GeneratedExport, StatutoryExportKind } from './statutory-exports'
import { decryptMoney, encryptTextFields } from './money-crypto'
import type { EmployeeDirectoryClient } from './ports'

/**
 * Generates M7-5's bank files and M7-6's statutory outputs from a run's
 * payslips.
 *
 * WHEN GENERATION HAPPENS IS FORCED BY THE SCHEMA, and the constraint is a
 * good one. `statutory_export_immutable_when_run_committed` blocks INSERT —
 * not just UPDATE — on a committed run's exports, because adding a new
 * สปส.1-10 to a filed period changes what that run's evidence says as
 * effectively as editing one would. So:
 *
 *  - `recordAll` runs INSIDE the commit transaction, before the status
 *    flips, and writes one immutable row per export with an encrypted
 *    MinIO reference. That row is the permanent record of what was
 *    produced for that period.
 *  - The download endpoints RE-RENDER deterministically from the (also
 *    immutable) payslips and return the file. They write nothing. A
 *    download is audited through the audit log, not by mutating a row that
 *    is, correctly, frozen.
 *
 * Re-rendering is safe precisely because every input is immutable: the same
 * committed run always produces byte-identical output, which is also what
 * makes an export reproducible for an auditor years later.
 *
 * IDENTITIES COME FROM `svc-onboarding`, not from this schema. A สปส.1-10
 * needs the employee's name and national ID; both are S3 fields owned by
 * another service, and the roadmap's rule is that a consumer fetches such a
 * field through the owning service's AUDITED api rather than replicating
 * it. `payroll_employee_ref` deliberately holds neither.
 */

const EXPORT_PURPOSE = 'payroll.statutory_export'

export class ExportsService {
  constructor(
    private readonly runs: RunsRepository,
    private readonly payslips: PayslipsRepository,
    private readonly profiles: PayProfilesRepository,
    private readonly profilesService: PayProfilesService,
    private readonly refs: RefsRepository,
    private readonly exports: ExportsRepository,
    private readonly directory: EmployeeDirectoryClient,
    private readonly config: ConfigClient,
    private readonly crypto: CryptoClient,
    private readonly newId: () => string,
    private readonly audit: AuditEmitter = new AuditEmitter(),
  ) {}

  /** Called from inside the commit transaction, before the run's status becomes `committed`. */
  async recordAll(tx: Queryable, run: PayrollRunRow): Promise<string[]> {
    const kinds: StatutoryExportKind[] = ['sso_1_10', 'pnd1']
    const recorded: string[] = []
    for (const kind of kinds) {
      const id = this.newId()
      const cipher = await encryptTextFields(this.crypto, id, {
        file_ref: `payroll/${run.period}/${run.id}/${kind}.csv`,
      })
      const fileRef = cipher.get('file_ref')
      if (fileRef === undefined) throw new Error('ExportsService: svc-crypto did not return file_ref ciphertext')
      await this.exports.insert(tx, { id, runId: run.id, kind, fileRef })
      recorded.push(kind)
    }
    for (const format of BANK_FORMATS) {
      const id = this.newId()
      const cipher = await encryptTextFields(this.crypto, id, {
        file_ref: `payroll/${run.period}/${run.id}/bank-${format}`,
      })
      const fileRef = cipher.get('file_ref')
      if (fileRef === undefined) throw new Error('ExportsService: svc-crypto did not return file_ref ciphertext')
      const built = buildBankFile(format, { runId: run.id, period: run.period, payDate: run.payDate ?? run.period, originatorAccount: '', originatorName: '', lines: [] })
      await this.exports.insert(tx, { id, runId: run.id, kind: built.kind, fileRef })
      recorded.push(built.kind)
    }
    return recorded
  }

  async renderStatutory(
    runId: string,
    kind: StatutoryExportKind,
    db: Queryable,
    actorId = 'unknown',
    actorRole = 'unknown',
  ): Promise<GeneratedExport> {
    const run = await this.requireCommitted(runId, db)
    const ctx = await this.buildContext(run, db)
    const generated = EXPORT_BUILDERS[kind](ctx)

    // "bank/statutory export generated ... this IS an export in the PDPA
    // sense — record it" (roadmap audit-coverage brief). `db` here is the
    // service's own pool, not a transaction — this download-and-render path
    // mutates nothing (`recordAll` already wrote the immutable
    // `statutory_export` row at commit time), so there is no caller
    // transaction to piggy-back on; a standalone `INSERT` into this
    // service's own outbox is the correct (and only available) unit here.
    await this.audit.emit(db, 'payroll', {
      actorId,
      actorRole,
      action: 'export.generated',
      entity: 'statutory_export',
      entityId: runId,
      after: { kind, period: run.period },
    })

    return generated
  }

  async renderBankFile(runId: string, format: string, db: Queryable, actorId = 'unknown', actorRole = 'unknown'): Promise<BankFileResult> {
    const run = await this.requireCommitted(runId, db)
    const resolver = new StatutoryResolver(this.config, run.periodEnd ?? run.period)
    const [name, account] = await Promise.all([
      resolver.requiredText(RULE_KEYS.employerName),
      resolver.requiredText(RULE_KEYS.employerDisbursementAccount),
    ])

    const lines: BankTransferLine[] = []
    for (const slip of await this.payslips.listByRun(runId, db)) {
      const profileRow = await this.profiles.findByEmployee(slip.employeeId, db)
      if (profileRow === null || profileRow.bankAccount === null || profileRow.bankCode === null) {
        // Refuse the whole file rather than pay some and silently skip
        // others: a partial payroll transfer is discovered by the employee
        // who was not paid, days later.
        throw bankAccountMissing(slip.employeeId)
      }
      const profile = await this.profilesService.decryptRow(profileRow, 'payroll.bank_file')
      if (profile.bankAccount === null) throw bankAccountMissing(slip.employeeId)
      const employee = await this.refs.findEmployee(slip.employeeId, db)
      lines.push({
        employeeId: slip.employeeId,
        empCode: employee?.empCode ?? null,
        accountName: profile.bankAccountName ?? '',
        bankCode: profile.bankCode ?? '',
        accountNumber: profile.bankAccount,
        netPay: await decryptMoney(this.crypto, slip.id, 'net', slip.net, 'payroll.bank_file'),
      })
    }

    const built = buildBankFile(format, {
      runId: run.id,
      period: run.period,
      payDate: run.payDate ?? run.period,
      originatorAccount: account.value,
      originatorName: name.value,
      lines,
    })

    // Same reasoning as `renderStatutory`'s audit emit above: a bank file is
    // an export in the PDPA sense (line count reveals nothing per-employee;
    // no account number or name is ever put in `after`).
    await this.audit.emit(db, 'payroll', {
      actorId,
      actorRole,
      action: 'export.generated',
      entity: 'bank_file',
      entityId: runId,
      after: { format: built.kind, period: run.period, lineCount: lines.length },
    })

    return built
  }

  private async requireCommitted(runId: string, db: Queryable): Promise<PayrollRunRow> {
    const run = await this.runs.findById(runId, db)
    if (run === null) throw runNotFound(runId)
    // PAY-050: an export of an uncommitted run is a filing of figures that
    // may still change.
    if (run.status !== 'committed') throw exportBeforeCommit(runId, run.status)
    return run
  }

  private async buildContext(run: PayrollRunRow, db: Queryable): Promise<ExportContext> {
    const asOf = run.periodEnd ?? `${run.period}-01`
    const resolver = new StatutoryResolver(this.config, asOf)
    const [employerName, ssoNumber, taxId] = await Promise.all([
      resolver.requiredText(RULE_KEYS.employerName),
      resolver.requiredText(RULE_KEYS.employerSsoNumber),
      resolver.requiredText(RULE_KEYS.employerTaxId),
    ])

    const slips = await this.payslips.listByRun(run.id, db)
    const identities = await this.directory.getIdentities(slips.map((s) => s.employeeId))

    const lines: ExportEmployeeLine[] = []
    for (const slip of slips) {
      const employee = await this.refs.findEmployee(slip.employeeId, db)
      const termination = await this.refs.findTermination(slip.employeeId, db)
      const identity = identities.get(slip.employeeId) ?? { fullName: '', nationalId: '' }
      const money = async (field: string, buf: Buffer | null): Promise<Satang> =>
        buf === null ? 0n : decryptMoney(this.crypto, slip.id, field, buf, EXPORT_PURPOSE)

      lines.push({
        employeeId: slip.employeeId,
        empCode: employee?.empCode ?? null,
        fullName: identity.fullName,
        nationalId: identity.nationalId,
        // The capped wage is reconstructed from the employee contribution
        // and the rate rather than stored twice — one figure, one truth.
        ssoWage: await this.cappedWage(slip.id, slip.ssoEmp, resolver),
        ssoEmployee: await money('sso_emp', slip.ssoEmp),
        ssoEmployer: await money('sso_er', slip.ssoEr),
        ewfEmployee: await money('ewf_emp', slip.ewfEmp),
        ewfEmployer: await money('ewf_er', slip.ewfEr),
        taxableGross: await money('taxable_gross', slip.taxableGross),
        wht: await money('tax_wht', slip.taxWht),
        startDate: employee?.startDate ?? null,
        terminationDate: termination?.terminationDate ?? null,
      })
    }

    return {
      runId: run.id,
      period: run.period,
      asOf,
      employerName: employerName.value,
      employerSsoNumber: ssoNumber.value,
      employerTaxId: taxId.value,
      lines,
    }
  }

  /** `contribution / rate` — the wage the contribution was actually computed on, using the SAME effective-dated rate the run used. */
  private async cappedWage(payslipId: string, ciphertext: Buffer, resolver: StatutoryResolver): Promise<Satang> {
    const contribution = await decryptMoney(this.crypto, payslipId, 'sso_emp', ciphertext, EXPORT_PURPOSE)
    const rate = await resolver.requiredPercent(RULE_KEYS.ssoRateEmployee)
    if (rate.value.num === 0n) return 0n
    return (contribution * rate.value.den) / rate.value.num
  }
}
