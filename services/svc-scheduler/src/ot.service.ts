import { GadongError, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { ConfigClient } from './config-client'
import { hoursStringToMinutes, minutesToHoursString } from './hours'
import type { OtRateClass, OtRequestRow } from './ot.repository'
import { OtRepository } from './ot.repository'
import { isoWeekRange } from './week'

export interface OtRequestInput {
  employeeId: string
  date: string
  hours: number
  rateClass: OtRateClass
  reason: string
  employeeConsent: boolean
}

export interface OtRequestResult {
  request: OtRequestRow
  weeklyOtTotal: { hours: string; ceilingHours: string; citation: string }
}

function missingConsent(): GadongError {
  // LPA s.24: OT requires the employee's consent per instance.
  return new GadongError('SCH-021', 'scheduler.error.ot_consent_required', 422, [{ citation: 'LPA s.24' }])
}

function otNotFound(id: string): GadongError {
  return new GadongError('SCH-404', 'scheduler.error.ot_request_not_found', 404, [{ id }])
}

function otNotPending(id: string): GadongError {
  return new GadongError('SCH-409', 'scheduler.error.ot_request_not_pending', 409, [{ id }])
}

function missingRejectReason(id: string): GadongError {
  return new GadongError('SCH-022', 'scheduler.error.ot_reject_reason_required', 422, [{ id }])
}

function weeklyOtCeilingExceeded(
  employeeId: string,
  weekTotalHours: string,
  ceilingHours: string,
  citation: string,
): GadongError {
  return new GadongError('SCH-020', 'scheduler.error.weekly_ot_ceiling_exceeded', 422, [
    { employeeId, hours: weekTotalHours, ceilingHours, citation },
  ])
}

/**
 * M2-5. `request()` records consent up front (LPA s.24 — SCH-021 if
 * missing) but does NOT re-check the weekly OT ceiling: the ceiling is a
 * gate on APPROVAL (M2-SCHEDULER §1.2 state diagram: "approved: approver OK
 * — guard: weekly OT ≤ 36h ceiling"), not on merely asking. `decide()` is
 * where the 36h/week ceiling (`hours.ot.max_per_week`, from `svc-config` —
 * never hard-coded) is actually enforced, and where `ot.approved` is
 * published to the outbox in the SAME transaction as the status change
 * (kernel `writeOutbox`, ADR-005) — the rate class travels through that
 * event payload unchanged from what was requested, which is what lets
 * payroll multiply by the right figure downstream.
 */
export class OtService {
  constructor(
    private readonly repo: OtRepository,
    private readonly configClient: ConfigClient,
  ) {}

  async request(tx: Queryable, input: OtRequestInput): Promise<OtRequestResult> {
    if (!input.employeeConsent) throw missingConsent()

    const hoursMinutes = Math.round(input.hours * 60)
    const hoursStr = minutesToHoursString(hoursMinutes)

    const created = await this.repo.insert(tx, {
      employeeId: input.employeeId,
      otDate: input.date,
      hours: hoursStr,
      rateClass: input.rateClass,
      reason: input.reason,
      employeeConsent: input.employeeConsent,
    })

    const weeklyOtTotal = await this.weeklyOtTotal(input.employeeId, input.date, hoursMinutes)
    return { request: created, weeklyOtTotal }
  }

  async decide(
    tx: Queryable,
    id: string,
    decision: 'approve' | 'reject',
    decidedBy: string,
    decisionReason: string | null,
  ): Promise<OtRequestRow> {
    const existing = await this.repo.findById(id)
    if (!existing) throw otNotFound(id)
    if (existing.status !== 'pending') throw otNotPending(id)

    if (decision === 'reject') {
      if (!decisionReason || decisionReason.trim().length === 0) throw missingRejectReason(id)
      const updated = await this.repo.decide(tx, id, 'rejected', decidedBy, decisionReason)
      if (!updated) throw otNotPending(id) // lost a race with a concurrent decision
      return updated
    }

    // approve: re-check the weekly ceiling against everything ALREADY
    // approved for this employee's week, plus this request's own hours.
    const requestMinutes = hoursStringToMinutes(existing.hours)
    const total = await this.weeklyOtTotal(existing.employeeId, existing.otDate, requestMinutes, id)
    const ceilingMinutes = hoursStringToMinutes(total.ceilingHours)
    const projectedMinutes = hoursStringToMinutes(total.hours)
    if (projectedMinutes > ceilingMinutes) {
      throw weeklyOtCeilingExceeded(existing.employeeId, total.hours, total.ceilingHours, total.citation)
    }

    const updated = await this.repo.decide(tx, id, 'approved', decidedBy, decisionReason)
    if (!updated) throw otNotPending(id) // lost a race with a concurrent decision

    // Same transaction as the status change (ADR-005) — the rate class
    // carried in this payload is exactly what payroll multiplies by.
    await writeOutbox(tx, 'scheduler', 'ot.approved', {
      employeeId: updated.employeeId,
      otDate: updated.otDate,
      hours: updated.hours,
      rateClass: updated.rateClass,
      approvedBy: decidedBy,
    })

    return updated
  }

  /** Sum of already-approved OT hours for `employeeId`'s ISO week containing `date`, plus `additionalMinutes` (the request under consideration), against the config-sourced 36h/week ceiling. `excludeRequestId` avoids double-counting a request that is itself already `approved` and being re-evaluated (not the case today — decide() only re-checks `pending` rows — but keeps this method correct if that ever changes). */
  private async weeklyOtTotal(
    employeeId: string,
    date: string,
    additionalMinutes: number,
    excludeRequestId?: string,
  ): Promise<{ hours: string; ceilingHours: string; citation: string }> {
    const { from, to } = isoWeekRange(date)
    const approved = await this.repo.findApprovedForEmployeeInRange(employeeId, from, to)
    const existingMinutes = approved
      .filter((r) => r.id !== excludeRequestId)
      .reduce((sum, r) => sum + hoursStringToMinutes(r.hours), 0)
    const totalMinutes = existingMinutes + additionalMinutes

    const ceiling = await this.configClient.getNumber('hours.ot.max_per_week')
    return {
      hours: minutesToHoursString(totalMinutes),
      ceilingHours: minutesToHoursString(Math.round(ceiling.value * 60)),
      citation: ceiling.citation,
    }
  }
}
