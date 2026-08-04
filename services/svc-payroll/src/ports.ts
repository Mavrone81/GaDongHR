import type { Queryable } from '@gadong/kernel'
import type { TimesheetTotals } from './engine/types'
import type { PayrollRunRow } from './runs.repository'

/**
 * The two synchronous service-to-service dependencies M7 has beyond
 * `svc-config` and `svc-crypto`. Both are interfaces here and real HTTP
 * clients in `app.module.ts`, so every test in this module runs against a
 * fake — there is no `svc-timesheet` or `svc-docs` in this environment, and
 * the roadmap's rule is that a consumer needing another service's data
 * fetches it through that service's audited API rather than replicating it.
 */

/**
 * Hours and days for a LOCKED timesheet period.
 *
 * `lockVersion` is passed on every call and is not decoration: a payroll
 * run binds to the version it prepared against, and asking for hours "as of
 * version 7" is what makes a later unlock detectable (PAY-030) rather than
 * silently changing what a calculated run was based on. An implementation
 * that ignores it, or a period that has moved on, must fail rather than
 * return the current hours.
 */
export interface TimesheetClient {
  getLockedTotals(period: string, lockVersion: number): Promise<Map<string, TimesheetTotals>>
}

export class HttpTimesheetClient implements TimesheetClient {
  constructor(private readonly baseUrl: string) {}

  async getLockedTotals(period: string, lockVersion: number): Promise<Map<string, TimesheetTotals>> {
    const url = `${this.baseUrl}/periods/${encodeURIComponent(period)}/totals?lockVersion=${encodeURIComponent(String(lockVersion))}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`svc-timesheet returned ${res.status.toString()} for ${period} @ v${lockVersion.toString()}`)
    const body: unknown = await res.json()
    const out = new Map<string, TimesheetTotals>()
    if (typeof body !== 'object' || body === null || !Array.isArray((body as { totals?: unknown }).totals)) return out
    for (const entry of (body as { totals: unknown[] }).totals) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const employeeId = e['employeeId']
      if (typeof employeeId !== 'string') continue
      // The three OT quantities are carried through VERBATIM from
      // `timesheet.day_record`'s `ot_15x` / `ot_2x` / `ot_3x`. In
      // particular `ot_2x` is a pay-rate-equivalent — already halved by M3
      // for monthly staff — and NOT raw hours worked; see
      // `TimesheetTotals.otHolidayWorkHours` for the full contract.
      // Re-deriving or re-scaling it here would pay a monthly employee half
      // the holiday premium LPA s.62 owes them.
      out.set(employeeId, {
        daysWorked: String(e['daysWorked'] ?? '0'),
        hoursWorked: String(e['hoursWorked'] ?? '0'),
        otWorkdayHours: String(e['otWorkdayHours'] ?? '0'),
        otHolidayWorkHours: String(e['otHolidayWorkHours'] ?? '0'),
        otHolidayOtHours: String(e['otHolidayOtHours'] ?? '0'),
      })
    }
    return out
  }
}

/** What a rendered payslip PDF needs from `svc-docs`: the template, the language, the data. Returns the MinIO object key, which this service then encrypts before writing it to `payslip.pdf_ref`. */
export interface DocsClient {
  renderPayslip(input: { payslipId: string; lang: string; html: string }): Promise<{ fileRef: string }>
}

export class HttpDocsClient implements DocsClient {
  constructor(private readonly baseUrl: string) {}

  async renderPayslip(input: { payslipId: string; lang: string; html: string }): Promise<{ fileRef: string }> {
    const res = await fetch(`${this.baseUrl}/documents/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'payslip', entityId: input.payslipId, lang: input.lang, html: input.html }),
    })
    if (!res.ok) throw new Error(`svc-docs returned ${res.status.toString()} rendering payslip ${input.payslipId}`)
    const body: unknown = await res.json()
    const fileRef = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['fileRef'] : undefined
    if (typeof fileRef !== 'string' || fileRef.length === 0) throw new Error('svc-docs returned no fileRef for a rendered payslip')
    return { fileRef }
  }
}

/**
 * Employee identities for the statutory filings — full name and national
 * ID. Both are S3 fields owned by `svc-onboarding`; the roadmap's rule is
 * that a consumer needing one fetches it through the owning service's
 * AUDITED API rather than replicating it, which is why
 * `payroll_employee_ref` holds neither. A สปส.1-10 without national IDs is
 * not a filing, so this dependency is real rather than convenient.
 */
export interface EmployeeIdentity {
  fullName: string
  nationalId: string
}

export interface EmployeeDirectoryClient {
  getIdentities(employeeIds: readonly string[]): Promise<Map<string, EmployeeIdentity>>
}

export class HttpEmployeeDirectoryClient implements EmployeeDirectoryClient {
  constructor(private readonly baseUrl: string) {}

  async getIdentities(employeeIds: readonly string[]): Promise<Map<string, EmployeeIdentity>> {
    const out = new Map<string, EmployeeIdentity>()
    if (employeeIds.length === 0) return out
    const res = await fetch(`${this.baseUrl}/employees/identities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The purpose travels with the request because reading a national ID
      // is an audited S3 read on the other side, not a plain lookup.
      body: JSON.stringify({ employeeIds, purpose: 'payroll.statutory_export' }),
    })
    if (!res.ok) throw new Error(`svc-onboarding returned ${res.status.toString()} resolving payroll identities`)
    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null || !Array.isArray((body as { employees?: unknown }).employees)) return out
    for (const entry of (body as { employees: unknown[] }).employees) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const id = e['id']
      if (typeof id !== 'string') continue
      out.set(id, { fullName: String(e['fullName'] ?? ''), nationalId: String(e['nationalId'] ?? '') })
    }
    return out
  }
}

/**
 * The narrow slice of `ExportsService` that `RunsService.commit` needs, so
 * the two services are not mutually dependent. Exports must be RECORDED
 * inside the commit transaction, before the run's status flips — after it,
 * the `statutory_export` INSERT trigger correctly refuses (adding a filing
 * to a committed period changes what its evidence says).
 */
export interface ExportRecorder {
  recordAll(tx: Queryable, run: PayrollRunRow): Promise<string[]>
}
