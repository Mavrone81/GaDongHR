import type { BalancesService } from './balances.service'
import { available } from './balances.service'
import type { LedgerEntryRow } from './balances.repository'
import type { LeaveTypesRepository } from './leave-types.repository'

export interface BalanceSummary {
  leaveTypeId: string
  leaveTypeCode: string
  year: number
  entitled: string
  taken: string
  carriedOver: string
  available: string
  /** Present only when the caller asked `?asOf=` — the projected available balance at that future date (M5-5). */
  projectedAvailable?: string
}

/**
 * Composes `LeaveTypesRepository` + `BalancesService` for the one ESS
 * read `GET /my/balances?year=&asOf=` needs (M5-5: "current balance,
 * accrual history, and projected balance at a future date"). Kept as its
 * own small service rather than inline controller logic — the controller
 * stays a thin HTTP boundary, matching every other route in this service.
 */
export class EssBalancesService {
  constructor(
    private readonly leaveTypes: LeaveTypesRepository,
    private readonly balances: BalancesService,
  ) {}

  async summarize(employeeId: string, year: number, asOfDate: string | undefined, today: string): Promise<BalanceSummary[]> {
    const types = (await this.leaveTypes.findAll()).filter((t) => t.active)
    const out: BalanceSummary[] = []
    for (const type of types) {
      // Small, bounded per-tenant type count; each iteration is an independent read.
      const balance = await this.balances.getOrDefault(employeeId, type.id, year)
      const summary: BalanceSummary = {
        leaveTypeId: type.id,
        leaveTypeCode: type.code,
        year,
        entitled: balance.entitled,
        taken: balance.taken,
        carriedOver: balance.carriedOver,
        available: available(balance),
      }
      if (asOfDate !== undefined) {
        // (see loop-start comment above)
        summary.projectedAvailable = await this.balances.project(employeeId, type, asOfDate, today)
      }
      out.push(summary)
    }
    return out
  }

  ledger(employeeId: string, leaveTypeId: string): Promise<LedgerEntryRow[]> {
    return this.balances.ledgerHistory(employeeId, leaveTypeId)
  }
}
