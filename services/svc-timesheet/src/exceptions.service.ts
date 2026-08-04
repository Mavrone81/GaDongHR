import { GadongError, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import type { ConsolidationService } from './consolidation.service'
import { CorrectionAuditRepository } from './correction-audit.repository'
import type { DayRecordRow } from './day-record.repository'
import { DayRecordRepository } from './day-record.repository'
import type { ExceptionKind, TimeExceptionRow } from './exception.repository'
import { ExceptionRepository } from './exception.repository'
import { PeriodRepository } from './period.repository'

export interface ProposeInput {
  actualIn?: string | null
  actualOut?: string | null
  resolutionNote: string
  /** Manager's justification — carried through to `confirm`'s immutable audit row as the "why". */
  reason: string
}

interface ProposedPayload {
  actualIn: string | null | undefined
  actualOut: string | null | undefined
  resolutionNote: string
  reason: string
}

function exceptionNotFound(id: string): GadongError {
  return new GadongError('TSH-060', 'timesheet.error.exception_not_found', 404, [{ id }])
}

function exceptionNotOpen(id: string): GadongError {
  return new GadongError('TSH-061', 'timesheet.error.exception_not_open', 409, [{ id }])
}

function exceptionNotProposed(id: string): GadongError {
  return new GadongError('TSH-062', 'timesheet.error.exception_not_proposed', 409, [{ id }])
}

function correctionOnLockedPeriod(dayRecordId: string, periodId: string): GadongError {
  // M3-TIMESHEET.md error catalog: TSH-010 "correction on locked period (use unlock flow)".
  return new GadongError('TSH-010', 'timesheet.error.correction_on_locked_period', 409, [{ dayRecordId, periodId }])
}

function isProposedPayload(v: unknown): v is ProposedPayload {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['resolutionNote'] === 'string'
}

/**
 * M3-3 — exception correction workflow (M3-TIMESHEET.md §1.2 state
 * diagram): `open -> proposed` (manager, via `propose`) `-> corrected` (HR,
 * via `confirm`, which writes the immutable who/when/why audit row and
 * republishes `timesheet.corrected`). `propose` never touches `day_record`
 * — it only records the manager's INTENT (so a locked period does not block
 * a manager from flagging what should change; only the actual write, at
 * `confirm`, is gated on the period being open — TSH-010, "use unlock
 * flow").
 */
export class ExceptionsService {
  constructor(
    private readonly exceptions: ExceptionRepository,
    private readonly dayRecords: DayRecordRepository,
    private readonly periods: PeriodRepository,
    private readonly correctionAudits: CorrectionAuditRepository,
    private readonly consolidation: ConsolidationService,
  ) {}

  async propose(tx: Queryable, exceptionId: string, proposedBy: string, input: ProposeInput): Promise<TimeExceptionRow> {
    const payload: ProposedPayload = {
      actualIn: input.actualIn,
      actualOut: input.actualOut,
      resolutionNote: input.resolutionNote,
      reason: input.reason,
    }
    const updated = await this.exceptions.propose(tx, exceptionId, JSON.stringify(payload), proposedBy)
    if (!updated) {
      const existing = await this.exceptions.findById(exceptionId)
      if (!existing) throw exceptionNotFound(exceptionId)
      throw exceptionNotOpen(exceptionId)
    }
    return updated
  }

  /**
   * Applies the manager's proposed fix, recomputes the day (worked
   * hours/late/OT all follow from the corrected punches), and records an
   * immutable before/after audit row — "every manual correction stores
   * who, when and why" (M3-3 AC, verbatim): `who` = `confirmedBy`, `when` =
   * the audit row's own `at` (server clock, kernel-side `now()`), `why` =
   * the manager's `reason`, carried through from `propose`.
   */
  async confirm(tx: Queryable, exceptionId: string, confirmedBy: string): Promise<{ exception: TimeExceptionRow; dayRecord: DayRecordRow }> {
    const exception = await this.exceptions.findByIdTx(tx, exceptionId)
    if (!exception) throw exceptionNotFound(exceptionId)
    if (exception.resolution === null || !exception.resolution.startsWith('proposed:')) throw exceptionNotProposed(exceptionId)

    let payload: unknown
    try {
      payload = JSON.parse(exception.resolution.slice('proposed:'.length))
    } catch {
      throw exceptionNotProposed(exceptionId)
    }
    if (!isProposedPayload(payload)) throw exceptionNotProposed(exceptionId)

    const before = await this.dayRecords.findById(exception.dayRecordId, tx)
    if (!before) throw exceptionNotFound(exceptionId) // orphaned exception — should not happen given the FK, defensive only

    const period = await this.periods.findContaining(before.workDate)
    if (period && period.status === 'locked') throw correctionOnLockedPeriod(before.id, period.id)

    const actualIn = payload.actualIn !== undefined ? payload.actualIn : before.actualIn
    const actualOut = payload.actualOut !== undefined ? payload.actualOut : before.actualOut
    await this.dayRecords.applyCorrection(tx, before.id, actualIn, actualOut)

    const afterCorrection = await this.dayRecords.findById(before.id, tx)
    if (!afterCorrection) throw exceptionNotFound(exceptionId) // unreachable: just wrote this row

    // Written BEFORE `recomputeDay` so its own `hasAnyCorrection` check
    // (which decides whether the day's status becomes `'corrected'`) sees
    // this correction — see `ConsolidationService.recomputeDay`'s doc.
    await this.correctionAudits.record(tx, before.id, confirmedBy, payload.reason, before, afterCorrection)

    const recomputed = await this.consolidation.recomputeDay(tx, before.employeeId, before.workDate)

    const confirmedException = await this.exceptions.confirm(tx, exceptionId, confirmedBy, payload.reason)
    if (!confirmedException) throw exceptionNotProposed(exceptionId) // lost a race with a concurrent confirm

    await writeOutbox(tx, 'timesheet', 'timesheet.corrected', {
      dayRecordId: recomputed.id,
      employeeId: recomputed.employeeId,
      workDate: recomputed.workDate,
      correctedBy: confirmedBy,
      reason: payload.reason,
      delta: { before: { actualIn: before.actualIn, actualOut: before.actualOut }, after: { actualIn: recomputed.actualIn, actualOut: recomputed.actualOut } },
    })

    return { exception: confirmedException, dayRecord: recomputed }
  }

  /** HR's manual punch (`POST /manual-punch`, M3-TIMESHEET.md API #7) — same event pipeline as a device punch (`method='manual'`), routed through `ConsolidationService` directly rather than the exception propose/confirm workflow, matching the API manual's own framing ("same event pipeline"). */
  async manualPunch(tx: Queryable, employeeId: string, punchedAt: string, direction: 'in' | 'out'): Promise<DayRecordRow> {
    return this.consolidation.applyPunch(tx, { employeeId, punchedAt, direction })
  }

  async queue(status: 'open' | 'resolved', employeeIds: string[] | null): Promise<TimeExceptionRow[]> {
    return this.exceptions.findByStatusAndEmployees(status, employeeIds)
  }
}

export type { ExceptionKind }
