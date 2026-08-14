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
 * `periodId` is svc-timesheet's OWN period-row uuid (`timesheet.period.id`),
 * never payroll's own 'YYYY-MM' period code — svc-timesheet's real route
 * addresses a period by its own primary key and has no concept of payroll's
 * calendar-month string. Callers get this uuid from `RefsRepository.
 * findTimesheetLock`'s `TimesheetLockRow.periodId` (populated by
 * `EventConsumersService.handleTimesheetLock` from the `timesheet.locked`
 * event, which is the only place this uuid is ever learned) — never from
 * `PayrollRunRow.period` directly.
 *
 * `lockVersion` is passed on every call and is not decoration: a payroll
 * run binds to the version it prepared against, and asking for hours "as of
 * version 7" is what makes a later unlock detectable (PAY-030) rather than
 * silently changing what a calculated run was based on. An implementation
 * that ignores it, or a period that has moved on, must fail rather than
 * return the current hours.
 */
export interface TimesheetClient {
  getLockedTotals(periodId: string, lockVersion: number): Promise<Map<string, TimesheetTotals>>
}

/**
 * `fetchImpl` defaults to the global `fetch`; `app.module.ts` passes
 * `createAuthenticatedFetch(machineTokenClient)` (S2S auth task) so this
 * call — guarded by `timesheet.totals.read`, a permission granted to NO
 * human role template (`services/svc-authz/src/seed/roles.ts`'s own doc on
 * `PAYROLL_TIMESHEET_TOTALS_READ`) — carries `svc-payroll`'s own machine
 * bearer token instead of the bare, unauthenticated request that route's
 * own doc comment (`timesheet.controller.ts`) and the e2e lifecycle suite
 * both previously documented as a known, open gap.
 */
export class HttpTimesheetClient implements TimesheetClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getLockedTotals(periodId: string, lockVersion: number): Promise<Map<string, TimesheetTotals>> {
    const url = `${this.baseUrl}/periods/${encodeURIComponent(periodId)}/totals?lockVersion=${encodeURIComponent(String(lockVersion))}`
    const res = await this.fetchImpl(url)
    if (!res.ok) throw new Error(`svc-timesheet returned ${res.status.toString()} for period ${periodId} @ v${lockVersion.toString()}`)
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

/**
 * `fetchImpl` defaults to the global `fetch`; `app.module.ts` passes
 * `createAuthenticatedFetch(machineTokenClient)` (S2S auth task) so this
 * call — guarded by `document.generate` — carries `svc-payroll`'s machine
 * bearer token.
 *
 * The URL is `{baseUrl}/render` — `services/svc-docs/src/documents.
 * controller.ts`'s `DocumentsController` is mounted with `@Controller()`
 * (no path prefix) and the render handler is `@Post('render')`, so
 * `/documents/render` (this file's previous URL) 404s against the real
 * service; found and fixed while wiring authentication into this exact
 * call site, since a 404 and a 403 look identical from here ("not ok") and
 * this defect would otherwise have stayed masked behind the auth fix.
 *
 * The request BODY shape was a second, separate defect of the same kind,
 * found later (real e2e run, past the auth fix): `svc-docs`'s real
 * `POST /render` originally accepted only `mergeFields` substituted into
 * one of its own fixed `templates/<kind>.<lang>.html` files, with no way
 * for a caller to supply already-composed HTML — but `payslip-render.ts`'s
 * `renderPayslipHtml` deliberately builds a full itemised payslip (every
 * earning/deduction line, its own statutory citation, non-taxable
 * payments kept separate from taxable ones, YTD) that no fixed
 * `templates/payslip.*.html` (a handful of static placeholders — company
 * name, employee name, one gross figure, one SSO figure) can represent
 * without losing that detail. Rather than discard the itemised renderer
 * `payslip-render.test.ts` already covers, `svc-docs`'s `POST /render`
 * gained a caller-owned `html` input, mutually exclusive with
 * `mergeFields` (`DocumentsService.resolveHtml`) — this client sends
 * `html`, never `mergeFields`, and `entityType: 'payslip'` (the row's own
 * subject, matching `entityId` already being the payslip's id).
 *
 * A THIRD defect of the same kind, found once the body-shape fix above let
 * this call actually reach `commit()`: `POST /render`'s real response body
 * (`RenderResponseBody` — `documents.controller.ts`) is `{id, kind,
 * entityType, entityId, lang, sha256}` — there has never been a `fileRef`
 * field in it; the rendered PDF's storage pointer is written to
 * `docs.document.file_ref` server-side (encrypted, `documents.service.ts`'s
 * `prepare()`) and never round-trips back to the caller at all — the one
 * way to later retrieve the PDF is `GET /documents/:id`, keyed on the
 * response's `id`. This method reads `id` and returns it AS `fileRef` —
 * the value `RunsService.writePayslip` re-encrypts into its own
 * `payslip.pdf_ref` column — because that column's job is exactly "the key
 * this service needs to fetch the PDF later", and `id` is that key.
 */
export class HttpDocsClient implements DocsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async renderPayslip(input: { payslipId: string; lang: string; html: string }): Promise<{ fileRef: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'payslip', entityType: 'payslip', entityId: input.payslipId, lang: input.lang, html: input.html }),
    })
    if (!res.ok) throw new Error(`svc-docs returned ${res.status.toString()} rendering payslip ${input.payslipId}`)
    const body: unknown = await res.json()
    const documentId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['id'] : undefined
    if (typeof documentId !== 'string' || documentId.length === 0) throw new Error('svc-docs returned no document id for a rendered payslip')
    return { fileRef: documentId }
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

/**
 * `fetchImpl` defaults to the global `fetch`; `app.module.ts` passes
 * `createAuthenticatedFetch(machineTokenClient)` (S2S auth task) so this
 * call carries `svc-payroll`'s machine bearer token.
 *
 * NOTE (found while wiring this call site, out of this task's scope to
 * fix): `svc-onboarding` has no `POST /employees/identities` route today —
 * only `EmployeeController`'s `/employees*`/`/self-service/:token` routes
 * exist (`services/svc-onboarding/src/employee.controller.ts`). This
 * client — and the permission it is granted (`svc-payroll`'s realm
 * client), matching this file's header on `IDENTITIES COME FROM
 * svc-onboarding` — is wired and ready for when that route is built;
 * calling it today 404s, independent of authentication. `renderStatutory`
 * (`exports.service.ts`, the only caller of `getIdentities`) is not
 * exercised by the e2e lifecycle suite, so this gap is not a CI blocker.
 */
export class HttpEmployeeDirectoryClient implements EmployeeDirectoryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getIdentities(employeeIds: readonly string[]): Promise<Map<string, EmployeeIdentity>> {
    const out = new Map<string, EmployeeIdentity>()
    if (employeeIds.length === 0) return out
    const res = await this.fetchImpl(`${this.baseUrl}/employees/identities`, {
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
