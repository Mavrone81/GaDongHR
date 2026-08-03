import { randomUUID } from 'node:crypto'
import { GadongError, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { GuardrailPolicy, hasBlocking } from './guardrail'
import type { Conflict, ConflictReport, RunningTotal } from './guardrail'
import { evaluateDailyTotal, evaluateWeeklyTotal } from './guardrail'
import { paidDurationMinutes } from './hours'
import { minutesToHoursString } from './hours'
import { LeaveRefRepository } from './leave-ref.repository'
import type { RosterEntryRow } from './roster.repository'
import { RosterRepository } from './roster.repository'
import { ShiftsRepository } from './shifts.repository'
import { addDays, diffDays, isoWeekRange } from './week'

export interface AssignInput {
  employeeId: string
  shiftId: string
  workDate: string
  hazardous?: boolean
  overrideReason?: string
}

export interface AssignResult {
  entry: RosterEntryRow
  conflictReport: ConflictReport
  totals: { daily: RunningTotal; weekly: RunningTotal }
}

export interface CopyPatternInput {
  sourceFrom: string
  sourceTo: string
  targetFrom: string
  employeeIds?: string[]
}

export interface CopyPatternResult {
  created: RosterEntryRow[]
  skipped: Array<{ employeeId: string; workDate: string; shiftId: string; reason: string }>
}

export interface PublishInput {
  from: string
  to: string
  orgUnitId?: string
  employeeIds?: string[]
}

export interface PublishResult {
  rosterId: string
  entryCount: number
  entries: RosterEntryRow[]
}

function shiftNotFound(shiftId: string): GadongError {
  return new GadongError('SCH-404', 'scheduler.error.shift_not_found', 404, [{ shiftId }])
}

function doubleBooking(employeeId: string, workDate: string, shiftId: string): GadongError {
  return new GadongError('SCH-011', 'scheduler.error.double_booking', 422, [{ employeeId, workDate, shiftId }])
}

function leaveCollision(employeeId: string, workDate: string): GadongError {
  return new GadongError('SCH-012', 'scheduler.error.leave_collision_override_required', 422, [
    { employeeId, workDate },
  ])
}

function blockingHoursConflict(conflict: Conflict): GadongError {
  return new GadongError(conflict.code, conflict.messageI18nKey, 422, [conflict.details])
}

function rosterEntryNotFound(id: string): GadongError {
  return new GadongError('SCH-404', 'scheduler.error.roster_entry_not_found', 404, [{ id }])
}

/**
 * M2-2/M2-4. Owns conflict detection (double-booking, leave collisions,
 * statutory-hours guardrails) and roster publishing; `roster.repository.ts`
 * and `shifts.repository.ts` are SQL-only, `guardrail.ts` is pure
 * evaluation logic, `leave-ref.repository.ts` is the local `leave.approved`
 * read model — this class composes them, matching `services/svc-config`'s
 * service/repository split.
 */
export class RosterService {
  constructor(
    private readonly rosterRepo: RosterRepository,
    private readonly shiftsRepo: ShiftsRepository,
    private readonly leaveRefRepo: LeaveRefRepository,
    private readonly guardrails: GuardrailPolicy,
  ) {}

  /**
   * PRD M2-2 AC: rostering an employee onto a date they have approved leave
   * warns and REQUIRES an override with a reason on the record; without a
   * reason the assignment is rejected (SCH-012), not silently created and
   * not silently blocked forever — supplying `overrideReason` on this same
   * call is enough to proceed, `POST /rosters/entries/:id/override` (see
   * `overrideExisting` below) exists for the case a leave approval lands
   * AFTER the entry already existed.
   */
  async assign(tx: Queryable, input: AssignInput): Promise<AssignResult> {
    const shift = await this.shiftsRepo.findById(input.shiftId)
    if (!shift) throw shiftNotFound(input.shiftId)

    const hazardous = input.hazardous ?? false
    const shiftMinutes = paidDurationMinutes({
      startT: shift.startT,
      endT: shift.endT,
      crossesMidnight: shift.crossesMidnight,
      breakMinutes: shift.breakRules.filter((b) => !b.paid).reduce((sum, b) => sum + b.minutes, 0),
    })

    // 1. Double booking: the exact same shift already assigned this employee this day.
    const sameDay = await this.rosterRepo.findByEmployeeAndDate(input.employeeId, input.workDate)
    if (sameDay.some((e) => e.shiftId === input.shiftId)) {
      throw doubleBooking(input.employeeId, input.workDate, input.shiftId)
    }

    // 2. Daily-hours ceiling (LPA s.23): sum of every shift already on this
    // day plus the one being added. Block-only (evaluateDailyTotal).
    const ceilings = await this.guardrails.loadCeilings(hazardous)
    const existingSameDayMinutes = await this.sumMinutes(sameDay)
    const dailyProjected = existingSameDayMinutes + shiftMinutes
    const daily = evaluateDailyTotal(dailyProjected, ceilings.dailyHours, ceilings.dailyCitation)
    if (daily.conflict) throw blockingHoursConflict(daily.conflict)

    // 3. Weekly-hours ceiling (LPA s.23, hazardous-flag-sensitive): sum of
    // every shift already in this ISO week plus the one being added. Warn
    // inside the buffer, block once genuinely exceeded.
    const { from, to } = isoWeekRange(input.workDate)
    const weekEntries = await this.rosterRepo.findByEmployeeAndDateRange(input.employeeId, from, to)
    const existingWeekMinutes = await this.sumMinutes(weekEntries)
    const weeklyProjected = existingWeekMinutes + shiftMinutes
    const weekly = evaluateWeeklyTotal(
      'SCH-010',
      'scheduler.error.weekly_hours',
      weeklyProjected,
      ceilings.weeklyHours,
      ceilings.weeklyCitation,
    )
    if (weekly.conflict && weekly.conflict.severity === 'block') throw blockingHoursConflict(weekly.conflict)

    // 4. Leave collision (PRD M2-2 AC): warn, and require an override reason to proceed.
    const onLeave = await this.leaveRefRepo.findApprovedCovering(input.employeeId, input.workDate)
    const items: Conflict[] = []
    if (weekly.conflict) items.push(weekly.conflict)
    let overrideReason: string | null = null
    if (onLeave.length > 0) {
      if (!input.overrideReason || input.overrideReason.trim().length === 0) {
        throw leaveCollision(input.employeeId, input.workDate)
      }
      overrideReason = input.overrideReason
      items.push({
        code: 'SCH-012',
        severity: 'warn',
        messageI18nKey: 'scheduler.error.leave_collision_override_required',
        details: { employeeId: input.employeeId, workDate: input.workDate, overrideReason },
      })
    }

    const entry = await this.rosterRepo.insert(tx, {
      employeeId: input.employeeId,
      shiftId: input.shiftId,
      workDate: input.workDate,
      overrideReason,
      hazardous,
    })

    return {
      entry,
      conflictReport: { items },
      totals: { daily: daily.total, weekly: weekly.total },
    }
  }

  /** `POST /rosters/entries/:id/override` — records an override reason on an EXISTING entry (e.g. leave was approved after the entry was already planned). */
  async overrideExisting(tx: Queryable, id: string, reason: string): Promise<RosterEntryRow> {
    if (!reason || reason.trim().length === 0) {
      throw new GadongError('SCH-012', 'scheduler.error.leave_collision_override_required', 422, [{ id }])
    }
    const updated = await this.rosterRepo.setOverrideReason(tx, id, reason)
    if (!updated) throw rosterEntryNotFound(id)
    return updated
  }

  async listGrid(from: string, to: string, employeeIds?: string[]): Promise<RosterEntryRow[]> {
    return this.rosterRepo.findByDateRange(from, to, employeeIds ?? null)
  }

  /**
   * Copies every roster entry in `[sourceFrom, sourceTo]` to the same
   * weekday offset starting at `targetFrom`, re-running the full `assign`
   * conflict/guardrail pipeline for each one. An entry that would violate a
   * blocking rule (double-booking, an hours ceiling) or would require a
   * leave-collision override this batch call cannot supply is SKIPPED, not
   * fatal to the rest of the copy — reported back in `skipped` rather than
   * aborting an otherwise-valid pattern copy over one conflicting day.
   */
  async copyPattern(tx: Queryable, input: CopyPatternInput): Promise<CopyPatternResult> {
    const offset = diffDays(input.sourceFrom, input.targetFrom)
    const sourceEntries = await this.rosterRepo.findByDateRange(input.sourceFrom, input.sourceTo, input.employeeIds ?? null)

    const created: RosterEntryRow[] = []
    const skipped: CopyPatternResult['skipped'] = []

    for (const source of sourceEntries) {
      const targetDate = addDays(source.workDate, offset)
      try {
        const result = await this.assign(tx, {
          employeeId: source.employeeId,
          shiftId: source.shiftId,
          workDate: targetDate,
          hazardous: source.hazardous,
        })
        created.push(result.entry)
      } catch (err) {
        const reason = err instanceof GadongError ? err.code : 'unknown_error'
        skipped.push({ employeeId: source.employeeId, workDate: targetDate, shiftId: source.shiftId, reason })
      }
    }

    return { created, skipped }
  }

  /** `POST /rosters/publish` — moves every `planned` entry in range to `published` and emits `roster.published` in the SAME transaction (ADR-005). */
  async publish(tx: Queryable, input: PublishInput): Promise<PublishResult> {
    const entries = await this.rosterRepo.publishRange(tx, input.from, input.to, input.employeeIds ?? null)
    const rosterId = randomUUID()

    await writeOutbox(tx, 'scheduler', 'roster.published', {
      rosterId,
      orgUnitId: input.orgUnitId ?? null,
      dateRange: { from: input.from, to: input.to },
      entryCount: entries.length,
    })

    return { rosterId, entryCount: entries.length, entries }
  }

  private async sumMinutes(entries: RosterEntryRow[]): Promise<number> {
    let total = 0
    for (const entry of entries) {
      const shift = await this.shiftsRepo.findById(entry.shiftId)
      if (!shift) continue // a shift deleted out from under an existing entry must not crash guardrail evaluation
      total += paidDurationMinutes({
        startT: shift.startT,
        endT: shift.endT,
        crossesMidnight: shift.crossesMidnight,
        breakMinutes: shift.breakRules.filter((b) => !b.paid).reduce((sum, b) => sum + b.minutes, 0),
      })
    }
    return total
  }
}

export { hasBlocking, minutesToHoursString }
