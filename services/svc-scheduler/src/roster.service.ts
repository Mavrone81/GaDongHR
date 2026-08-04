import { randomUUID } from 'node:crypto'
import { GadongError, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { GuardrailPolicy, hasBlocking } from './guardrail'
import type { Conflict, ConflictReport, RunningTotal } from './guardrail'
import { evaluateDailyTotal, evaluateWeeklyTotal } from './guardrail'
import { paidDurationMinutes } from './hours'
import { minutesToHoursString } from './hours'
import { HolidaysRepository } from './holidays.repository'
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

/** Shift times are stored as `HH:MM` or `HH:MM:SS`; `roster.entry.published`'s ISO timestamps need seconds. */
function normaliseTime(t: string): string {
  return /^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t
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
    private readonly holidaysRepo: HolidaysRepository,
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

  /**
   * `POST /rosters/publish` — moves every `planned` entry in range to
   * `published` and emits, in the SAME transaction (ADR-005), TWO events:
   *
   *  - `roster.published`, the terse summary the roadmap's event catalog
   *    specifies: "a roster was published, this wide, this many entries".
   *  - `roster.entry.published`, ONE PER ENTRY, carrying the shift timing a
   *    consumer needs to build a per-employee-per-day read model.
   *
   * **Why two (fixed 2026-08-04, integration reconciliation).** M3
   * (`svc-timesheet`) consumed `roster.published` expecting the per-entry
   * shape — `employeeId`, `workDate`, `scheduledStart`, `scheduledEnd`,
   * `rosterEntryId` — and this service published only the summary. In
   * production every publish would have thrown
   * `roster.published: missing or invalid "employeeId"` in M3's consumer,
   * `timesheet.roster_ref` would never have populated, and both sides'
   * unit tests would have kept passing: each tested its own payload shape
   * against its own fixture, and nothing ran the two together.
   *
   * The summary is not wrong and the per-entry payload is not wrong — they
   * are two different events that were sharing one routing key. The summary
   * is what a notification or an audit consumer wants; the per-entry stream
   * is what a read model needs, and it matches how `employee.created` /
   * `employee.updated` already feed every service's `*_employee_ref` table.
   *
   * `isHoliday` is resolved HERE, from this service's own holiday calendar,
   * because `svc-scheduler` owns `holiday.manage` and is the only source of
   * truth for it. That field is load-bearing: it is what drives M3's
   * `ot_2x`/`ot_3x` holiday classification (`ot-classifier.ts`), so a
   * consumer defaulting it to `false` would silently zero every holiday OT
   * premium in the product.
   */
  async publish(tx: Queryable, input: PublishInput): Promise<PublishResult> {
    const entries = await this.rosterRepo.publishRange(tx, input.from, input.to, input.employeeIds ?? null)
    const rosterId = randomUUID()

    await writeOutbox(tx, 'scheduler', 'roster.published', {
      rosterId,
      orgUnitId: input.orgUnitId ?? null,
      dateRange: { from: input.from, to: input.to },
      entryCount: entries.length,
    })

    const holidays = await this.holidayDatesIn(input.from, input.to)
    for (const entry of entries) {
      const shift = await this.shiftsRepo.findById(entry.shiftId)
      // A shift deleted out from under a published entry cannot produce
      // timing, and inventing a window would be worse than omitting the
      // event — `sumMinutes` skips the same case for the same reason.
      if (!shift) continue
      await writeOutbox(tx, 'scheduler', 'roster.entry.published', {
        rosterId,
        rosterEntryId: entry.id,
        employeeId: entry.employeeId,
        workDate: entry.workDate,
        scheduledStart: `${entry.workDate}T${normaliseTime(shift.startT)}Z`,
        scheduledEnd: `${shift.crossesMidnight ? addDays(entry.workDate, 1) : entry.workDate}T${normaliseTime(shift.endT)}Z`,
        graceMin: shift.graceMin,
        hazardous: entry.hazardous,
        isHoliday: holidays.has(entry.workDate),
      })
    }

    return { rosterId, entryCount: entries.length, entries }
  }

  /**
   * Public-holiday dates within `[from, to]`, from this service's own
   * calendar. Substitute holidays count: a substitute IS the observed
   * holiday for LPA s.62 purposes, which is the whole point of generating
   * them (`holidays.service.ts`'s `computeSubstitutes`).
   */
  private async holidayDatesIn(from: string, to: string): Promise<Set<string>> {
    const dates = new Set<string>()
    const firstYear = Number(from.slice(0, 4))
    const lastYear = Number(to.slice(0, 4))
    if (!Number.isFinite(firstYear) || !Number.isFinite(lastYear)) return dates
    // A publish range may straddle a year boundary (a December-to-January
    // fortnight), and each year is a separate calendar row.
    for (let year = firstYear; year <= lastYear; year += 1) {
      const calendar = await this.holidaysRepo.findCalendarByYear(year)
      if (!calendar) continue
      for (const holiday of await this.holidaysRepo.listByCalendar(calendar.id)) {
        if (holiday.holidayDate >= from && holiday.holidayDate <= to) dates.add(holiday.holidayDate)
      }
    }
    return dates
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
