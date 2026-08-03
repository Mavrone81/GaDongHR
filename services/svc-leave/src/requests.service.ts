import { cryptoUnavailable, writeOutbox } from '@gadong/kernel'
import type { CryptoClient, Queryable } from '@gadong/kernel'
import * as Decimal from './decimal'
import { available } from './balances.service'
import type { BalancesService } from './balances.service'
import type { ConfigClient } from './config-client'
import {
  cancelWindowPassed,
  datesOverlap,
  halfDayMustBeSingleDate,
  halfDayNotAllowed,
  hourlyNotAllowed,
  insufficientBalance,
  leaveRequestNotFound,
  leaveTypeInactive,
  leaveTypeNotFound,
  medicalCertificateRequired,
  notRequestOwner,
  requestAlreadyDecided,
  statutoryRuleNotResolved,
} from './errors'
import type { LeaveTypesRepository } from './leave-types.repository'
import type { LeaveTypeRow } from './leave-types.repository'
import { datesArray } from './requests.repository'
import type { HalfDayPeriod, LeaveRequestRow, RequestsRepository } from './requests.repository'

export interface SubmitLeaveRequestInput {
  id?: string
  employeeId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  halfDayPeriod?: HalfDayPeriod
  /** `numeric` string. Present only for hourly requests (`leaveType.allowsHourly`). */
  hours?: string
  /** The PLAINTEXT pointer to a medical certificate (e.g. an object-storage key) — never stored as-is. Encrypted via `CryptoClient.encryptBatch` before `attachment_ref` is ever written (see `submit`'s doc). */
  attachmentPointer?: string
}

function isPlainNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

/**
 * Business logic behind `POST /requests` and `POST /requests/:id/cancel` —
 * no SQL here (`requests.repository.ts` owns that).
 *
 * `submit()` is where the PDPA s.26 boundary this whole module exists to
 * hold lives: `attachmentPointer` (a medical certificate's object-storage
 * pointer) is passed through the kernel's `CryptoClient.encryptBatch`
 * BEFORE `RequestsRepository.insert` is ever called — `attachment_ref` is
 * a `bytea` column and this is the only path that ever writes to it (Task
 * brief: "the attachment reference is encrypted before write, it points at
 * health data").
 */
export class RequestsService {
  constructor(
    private readonly repo: RequestsRepository,
    private readonly leaveTypes: LeaveTypesRepository,
    private readonly balances: BalancesService,
    private readonly crypto: CryptoClient,
    private readonly config: ConfigClient,
    private readonly genId: () => string,
  ) {}

  /** Backs `GET /approvals` (the approval queue): every currently-`pending` request's id, across all employees — see `approvals.service.ts`'s `listPendingForApprover` for why this service's repositories only support equality WHERE clauses rather than a join. */
  async listPendingRequestIds(): Promise<string[]> {
    return (await this.repo.listByStatus('pending')).map((r) => r.id)
  }

  async submit(tx: Queryable, input: SubmitLeaveRequestInput): Promise<LeaveRequestRow> {
    const leaveType = await this.leaveTypes.findById(input.leaveTypeId)
    if (!leaveType) throw leaveTypeNotFound(input.leaveTypeId)
    if (!leaveType.active) throw leaveTypeInactive(input.leaveTypeId)

    const id = input.id ?? this.genId()
    const days = await this.computeDays(leaveType, input)

    await this.assertNoOverlap(input.employeeId, input.startDate, input.endDate)
    await this.assertSufficientBalance(leaveType, input.employeeId, input.startDate, days)

    const certRequired = this.isCertRequired(leaveType, days)
    if (certRequired && input.attachmentPointer === undefined) {
      throw medicalCertificateRequired(leaveType.certTriggerDays ?? '0')
    }

    const attachmentRef = input.attachmentPointer !== undefined ? await this.encryptAttachment(id, input.attachmentPointer) : null

    return this.repo.insert(tx, {
      id,
      employeeId: input.employeeId,
      leaveTypeId: leaveType.id,
      startDate: input.startDate,
      endDate: input.endDate,
      days,
      hours: input.hours ?? null,
      halfDayPeriod: input.halfDayPeriod ?? null,
      attachmentRef,
      certRequired,
      status: 'pending',
    })
  }

  /**
   * Guarded cancel (M5-LEAVE.md §1.1, `LeaveRequest.cancel() guard:
   * notStarted|policy`): the requester's own pending request cancels
   * freely; an already-approved request may still cancel up to the day it
   * starts, after which `LVE-040` applies. Cancelling a previously-approved
   * request reverses its balance deduction and publishes `leave.cancelled`
   * (so M3/M2 can un-write it) — cancelling a still-pending request does
   * neither, since nothing downstream has consumed it yet.
   */
  async cancel(tx: Queryable, requestId: string, actorId: string, today: string): Promise<LeaveRequestRow> {
    const request = await this.repo.findById(requestId)
    if (!request) throw leaveRequestNotFound(requestId)
    if (request.employeeId !== actorId) throw notRequestOwner(requestId)
    if (request.status === 'cancelled' || request.status === 'rejected') throw requestAlreadyDecided(requestId)
    if (request.status === 'approved' && today > request.startDate) throw cancelWindowPassed(requestId)

    const wasApproved = request.status === 'approved'
    const leaveType = wasApproved ? await this.leaveTypes.findById(request.leaveTypeId) : null

    const updated = await this.repo.updateStatus(tx, requestId, 'cancelled')
    if (!updated) throw leaveRequestNotFound(requestId)

    if (wasApproved && leaveType) {
      const year = Number(request.startDate.slice(0, 4))
      await this.balances.reverseTaken(tx, request.employeeId, request.leaveTypeId, year, request.days, request.id)
      await writeOutbox(tx, 'leave', 'leave.cancelled', {
        requestId: request.id,
        employeeId: request.employeeId,
        leaveTypeCode: leaveType.code,
        dates: datesArray(request),
        days: request.days,
        payMode: leaveType.payMode,
      })
    }

    return updated
  }

  private isCertRequired(leaveType: LeaveTypeRow, days: string): boolean {
    if (leaveType.certTriggerDays === null) return false
    return Decimal.compare(days, leaveType.certTriggerDays) >= 0
  }

  private async encryptAttachment(requestId: string, plaintextPointer: string): Promise<Buffer> {
    const ciphertexts = await this.crypto.encryptBatch([
      { entityId: requestId, field: 'attachment_ref', value: plaintextPointer, fieldClass: 'S3' },
    ])
    const ct = ciphertexts.get('attachment_ref')
    // encryptBatch never returns successfully with a requested field missing (kernel CryptoClient's contract) — defensive, not a real path.
    if (!ct) throw cryptoUnavailable()
    return ct
  }

  private async computeDays(leaveType: LeaveTypeRow, input: SubmitLeaveRequestInput): Promise<string> {
    if (input.halfDayPeriod !== undefined) {
      if (!leaveType.allowsHalfDay) throw halfDayNotAllowed(leaveType.id)
      if (input.startDate !== input.endDate) throw halfDayMustBeSingleDate()
      return '0.5'
    }
    if (input.hours !== undefined) {
      if (!leaveType.allowsHourly) throw hourlyNotAllowed(leaveType.id)
      // The hourly-to-day conversion divisor is the statutory regular-hours-
      // per-day figure (LPA s.23, floor 8) — resolved from config at
      // request time, never a literal `8` in this file (Task brief
      // CONSTRAINTS).
      const rule = await this.config.getEffectiveRule('hours.regular.max_per_day')
      if (!rule || !isPlainNumber(rule.value) || rule.value <= 0) throw statutoryRuleNotResolved('hours.regular.max_per_day')
      return Decimal.mulFractionRound(input.hours, 1, rule.value)
    }
    return this.countInclusiveDays(input.startDate, input.endDate)
  }

  private countInclusiveDays(startDate: string, endDate: string): string {
    const start = new Date(`${startDate}T00:00:00Z`)
    const end = new Date(`${endDate}T00:00:00Z`)
    const diffDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
    return String(Math.max(0, diffDays))
  }

  private async assertNoOverlap(employeeId: string, startDate: string, endDate: string): Promise<void> {
    const existing = await this.repo.listByEmployee(employeeId)
    const overlaps = existing.some(
      (r) => (r.status === 'pending' || r.status === 'approved') && rangesOverlap(startDate, endDate, r.startDate, r.endDate),
    )
    if (overlaps) throw datesOverlap(employeeId)
  }

  private async assertSufficientBalance(leaveType: LeaveTypeRow, employeeId: string, startDate: string, days: string): Promise<void> {
    if (leaveType.payMode === 'unpaid') return
    const year = Number(startDate.slice(0, 4))
    const balance = await this.balances.getOrDefault(employeeId, leaveType.id, year)
    const availableDays = available(balance)
    if (Decimal.compare(availableDays, days) < 0) {
      throw insufficientBalance(employeeId, leaveType.id, days, availableDays)
    }
  }
}
