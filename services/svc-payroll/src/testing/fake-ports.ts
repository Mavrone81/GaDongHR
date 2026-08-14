import type { Queryable } from '@gadong/kernel'
import type { TimesheetTotals } from '../engine/types'
import type { DocsClient, EmployeeDirectoryClient, EmployeeIdentity, ExportRecorder, TimesheetClient } from '../ports'
import type { PayrollRunRow } from '../runs.repository'

/**
 * Fakes for the four service-to-service ports. There is no
 * `svc-timesheet`, `svc-docs` or `svc-onboarding` in this environment, and
 * M3 is being built concurrently — testing against a fake is the only
 * honest option, and matches how every other module in this codebase tests
 * a cross-service dependency.
 */

/**
 * Locked timesheet totals. The fake ENFORCES the lock-version contract
 * rather than ignoring it: asking for a version other than the one it was
 * seeded with throws, exactly as a real `svc-timesheet` must when the
 * period has been unlocked and re-locked underneath a bound run. A fake
 * that returned the current hours regardless would make the PAY-030 stale-
 * lock test meaningless.
 */
export class FakeTimesheetClient implements TimesheetClient {
  // Keyed on whatever identifier the caller passes `getLockedTotals` —
  // in production that is svc-timesheet's period-row uuid
  // (`TimesheetLockRow.periodId`), never payroll's own 'YYYY-MM' code; a
  // test seeds by whichever identifier it will also pass to `RunsService`
  // via `upsertTimesheetLock`'s `periodId`.
  private readonly byPeriodId = new Map<string, { lockVersion: number; totals: Map<string, TimesheetTotals> }>()
  readonly calls: Array<{ periodId: string; lockVersion: number }> = []

  seed(periodId: string, lockVersion: number, totals: Record<string, TimesheetTotals>): void {
    this.byPeriodId.set(periodId, { lockVersion, totals: new Map(Object.entries(totals)) })
  }

  async getLockedTotals(periodId: string, lockVersion: number): Promise<Map<string, TimesheetTotals>> {
    this.calls.push({ periodId, lockVersion })
    const entry = this.byPeriodId.get(periodId)
    if (entry === undefined) return new Map()
    if (entry.lockVersion !== lockVersion) {
      throw new Error(`FakeTimesheetClient: asked for ${periodId} at lock v${lockVersion.toString()}, seeded at v${entry.lockVersion.toString()}`)
    }
    return entry.totals
  }
}

export class FakeDocsClient implements DocsClient {
  readonly rendered: Array<{ payslipId: string; lang: string; html: string }> = []

  async renderPayslip(input: { payslipId: string; lang: string; html: string }): Promise<{ fileRef: string }> {
    this.rendered.push(input)
    return { fileRef: `minio://payslips/${input.payslipId}.pdf` }
  }
}

export class FakeDirectoryClient implements EmployeeDirectoryClient {
  private readonly identities = new Map<string, EmployeeIdentity>()

  seed(employeeId: string, identity: EmployeeIdentity): void {
    this.identities.set(employeeId, identity)
  }

  async getIdentities(employeeIds: readonly string[]): Promise<Map<string, EmployeeIdentity>> {
    const out = new Map<string, EmployeeIdentity>()
    for (const id of employeeIds) {
      const identity = this.identities.get(id)
      if (identity !== undefined) out.set(id, identity)
    }
    return out
  }
}

/** Records that `commit` asked for exports BEFORE the status flipped — which is the only window in which the real `statutory_export` INSERT trigger allows it. */
export class FakeExportRecorder implements ExportRecorder {
  readonly recorded: Array<{ runId: string; statusAtRecord: string }> = []

  async recordAll(_tx: Queryable, run: PayrollRunRow): Promise<string[]> {
    void _tx
    this.recorded.push({ runId: run.id, statusAtRecord: run.status })
    return []
  }
}
