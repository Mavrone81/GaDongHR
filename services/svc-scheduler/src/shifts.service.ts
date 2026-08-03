import { GadongError } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { rawSpanMinutes } from './hours'
import type { NewShiftRow, ShiftPatch, ShiftRow } from './shifts.repository'
import { ShiftsRepository } from './shifts.repository'

function shiftNotFound(id: string): GadongError {
  return new GadongError('SCH-404', 'scheduler.error.shift_not_found', 404, [{ id }])
}

function invalidShiftTiming(reason: string): GadongError {
  return new GadongError('SCH-013', 'scheduler.error.invalid_shift_timing', 422, [{ reason }])
}

/**
 * M2-1. `hours.ts`'s `rawSpanMinutes` already rejects a same-day shift
 * whose `endT` is not after `startT` when `crossesMidnight` is false — this
 * service calls it once at create/update time (not just lazily whenever a
 * roster assignment happens to touch the shift) so a malformed shift
 * definition is rejected at the moment it is authored, with a clear error,
 * rather than surfacing later as a confusing guardrail failure.
 */
export class ShiftsService {
  constructor(private readonly repo: ShiftsRepository) {}

  async create(tx: Queryable, input: NewShiftRow): Promise<ShiftRow> {
    this.validateTiming(input)
    return this.repo.insert(tx, input)
  }

  async list(): Promise<ShiftRow[]> {
    return this.repo.list()
  }

  async get(id: string): Promise<ShiftRow> {
    const row = await this.repo.findById(id)
    if (!row) throw shiftNotFound(id)
    return row
  }

  async patch(tx: Queryable, id: string, patch: ShiftPatch): Promise<ShiftRow> {
    const existing = await this.repo.findById(id)
    if (!existing) throw shiftNotFound(id)

    const merged: NewShiftRow = {
      nameI18n: patch.nameI18n ?? existing.nameI18n,
      startT: patch.startT ?? existing.startT,
      endT: patch.endT ?? existing.endT,
      crossesMidnight: patch.crossesMidnight ?? existing.crossesMidnight,
      breakRules: patch.breakRules ?? existing.breakRules,
      graceMin: patch.graceMin ?? existing.graceMin,
      differential: patch.differential === undefined ? existing.differential : patch.differential,
    }
    this.validateTiming(merged)

    const updated = await this.repo.update(tx, id, merged)
    if (!updated) throw shiftNotFound(id)
    return updated
  }

  private validateTiming(row: NewShiftRow): void {
    try {
      rawSpanMinutes(row)
    } catch (err) {
      throw invalidShiftTiming(err instanceof Error ? err.message : String(err))
    }
  }
}
