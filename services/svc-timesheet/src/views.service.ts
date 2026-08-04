import { GadongError } from '@gadong/kernel'
import type { DayRecordRow } from './day-record.repository'
import { DayRecordRepository } from './day-record.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import type { ExceptionKind, TimeExceptionRow } from './exception.repository'
import { ExceptionRepository } from './exception.repository'
import type { OrgScope } from './org-scope'
import { resolveScopedEmployeeIds, scopeAllowsEmployee, scopeAllowsOrgUnit } from './org-scope'

function orgUnitOutOfScope(orgUnitId: string): GadongError {
  return new GadongError('TSH-070', 'timesheet.error.org_unit_out_of_scope', 403, [{ orgUnitId }])
}

function employeeOutOfScope(employeeId: string): GadongError {
  return new GadongError('TSH-071', 'timesheet.error.employee_out_of_scope', 403, [{ employeeId }])
}

export interface ExceptionQueueEntry {
  exception: TimeExceptionRow
  dayRecord: DayRecordRow
}

/**
 * M3-5 — employee/manager/HR views, each row-scoped per `org-scope.ts`'s
 * doc (the roadmap security-gap fix this service closes for itself). No
 * route here trusts a caller-supplied `employeeId`/`orgUnitId` without
 * checking it against the `OrgScope` `svc-authz` returned for THIS caller —
 * `TimesheetController` is responsible for obtaining that `Decision` (a
 * second `AuthzClient.decide()` call, see `org-scope.ts`) and passing its
 * `scopeOrgUnitIds` in here.
 */
export class ViewsService {
  constructor(
    private readonly dayRecords: DayRecordRepository,
    private readonly employeeRefs: EmployeeRefRepository,
    private readonly exceptions: ExceptionRepository,
  ) {}

  /** `GET /my/days` — self-scoped by construction: `employeeId` is always the authenticated caller's own id, never a request parameter, so there is no scope to check here at all. */
  async myDays(employeeId: string, from: string, to: string): Promise<DayRecordRow[]> {
    return this.dayRecords.findByEmployeesAndRange([employeeId], from, to)
  }

  /** `GET /teams/{orgUnit}/days` — refuses (`TSH-070`) unless `scope` covers `orgUnitId`; a manager's `scopeOrgUnitIds` for a DIFFERENT team, or a peer manager's team, never satisfies this. */
  async teamDays(orgUnitId: string, from: string, to: string, scope: OrgScope): Promise<DayRecordRow[]> {
    if (!scopeAllowsOrgUnit(scope, orgUnitId)) throw orgUnitOutOfScope(orgUnitId)
    const employeeIds = (await this.employeeRefs.findByOrgUnits([orgUnitId])).map((e) => e.employeeId)
    return this.dayRecords.findByEmployeesAndRange(employeeIds, from, to)
  }

  /** `GET /days/{employeeId}` (HR org-wide view) — refuses (`TSH-071`) unless `scope` covers this specific employee (their org unit, or `'*'`, or `scope === 'self'` matching the caller). */
  async employeeDays(employeeId: string, from: string, to: string, callerId: string, scope: OrgScope): Promise<DayRecordRow[]> {
    const ref = await this.employeeRefs.findById(employeeId)
    if (!scopeAllowsEmployee(scope, callerId, employeeId, ref?.orgUnitId ?? null)) throw employeeOutOfScope(employeeId)
    return this.dayRecords.findByEmployeesAndRange([employeeId], from, to)
  }

  /** Every day_record in `[from, to]`, unfiltered — only valid for a caller whose scope is genuinely `'*'` (the controller enforces that; this method itself applies no filter, matching `findByEmployeesAndRange(null, ...)`'s own "null means every employee" contract). */
  async allDays(from: string, to: string): Promise<DayRecordRow[]> {
    return this.dayRecords.findByEmployeesAndRange(null, from, to)
  }

  /** Every day_record in `[from, to]` for employees across ALL of `orgUnitIds` — the multi-team case (a manager's `scopeOrgUnitIds` array can legitimately name more than one org unit, e.g. an interim manager covering two teams). */
  async orgUnitsDays(orgUnitIds: string[], from: string, to: string): Promise<DayRecordRow[]> {
    const employeeIds = (await this.employeeRefs.findByOrgUnits(orgUnitIds)).map((e) => e.employeeId)
    return this.dayRecords.findByEmployeesAndRange(employeeIds, from, to)
  }

  /** `GET /exceptions?status&org_unit` — scoped the same way as `teamDays`/`employeeDays`; `orgUnitId: null` means "whatever the caller's own scope covers" (used by HR's org-wide queue, where `scope === '*'`). */
  async exceptionsQueue(status: 'open' | 'resolved', orgUnitId: string | null, callerId: string, scope: OrgScope): Promise<TimeExceptionRow[]> {
    if (orgUnitId !== null) {
      if (!scopeAllowsOrgUnit(scope, orgUnitId)) throw orgUnitOutOfScope(orgUnitId)
      const employeeIds = (await this.employeeRefs.findByOrgUnits([orgUnitId])).map((e) => e.employeeId)
      return this.exceptions.findByStatusAndEmployees(status, employeeIds)
    }
    const employeeIds = await resolveScopedEmployeeIds(scope, callerId, async (orgUnitIds) =>
      (await this.employeeRefs.findByOrgUnits(orgUnitIds)).map((e) => e.employeeId),
    )
    return this.exceptions.findByStatusAndEmployees(status, employeeIds)
  }
}

export type { ExceptionKind }
