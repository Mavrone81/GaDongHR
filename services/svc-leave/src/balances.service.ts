import { writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import * as Decimal from './decimal'
import { BalancesRepository } from './balances.repository'
import type { LeaveBalanceRow, LedgerEntryRow } from './balances.repository'
import type { LeaveTypeRow } from './leave-types.repository'

const MONTHS_PER_YEAR = 12

/**
 * Days remaining (inclusive of the start month) in `year` for an employee
 * whose service starts on `startDate` — the month-granularity pro-ration
 * method: `remainingMonths / 12`, applied to `entitlementDays`.
 *
 * Deliberately month-granularity, not day-granularity: a day-based fraction
 * (e.g. `daysRemaining / 365`) is not exactly representable at any finite
 * decimal scale for an arbitrary hire date, which would force silent
 * rounding on every single pro-ration. Month granularity is the common HR
 * pro-ration convention AND keeps every fraction `mulFractionRound` produces
 * auditable (see `decimal.ts`).
 *
 * BOUNDARY: a joiner on the LAST day of the year (e.g. 31 Dec) still counts
 * as starting in December — remainingMonths = 1, not 0. This is the
 * boundary case the Task brief calls for ("assert a boundary, not just a
 * happy case"): a joiner hired on the final day of the year is not entitled
 * to nothing.
 */
export function remainingMonthsInYear(startDate: string, year: number): number {
  const start = new Date(`${startDate}T00:00:00Z`)
  const startYear = start.getUTCFullYear()
  if (startYear > year) return 0
  if (startYear < year) return MONTHS_PER_YEAR
  const startMonth = start.getUTCMonth() + 1 // 1-12
  return MONTHS_PER_YEAR - startMonth + 1
}

export function prorate(entitlementDays: string, startDate: string, year: number): string {
  const remaining = remainingMonthsInYear(startDate, year)
  if (remaining <= 0) return Decimal.ZERO
  if (remaining >= MONTHS_PER_YEAR) return entitlementDays
  return Decimal.mulFractionRound(entitlementDays, remaining, MONTHS_PER_YEAR)
}

/** `entitled + carriedOver - taken`, never floored — callers that need a non-negative figure (a payout) call `Decimal.clampNonNegative` themselves; `available` alone must still be able to go negative to describe an over-drawn balance honestly. */
export function available(balance: Pick<LeaveBalanceRow, 'entitled' | 'taken' | 'carriedOver'>): string {
  return Decimal.subtract(Decimal.add(balance.entitled, balance.carriedOver), balance.taken)
}

/**
 * Business logic behind balances/accrual/carry-over/payout — no SQL here
 * (`balances.repository.ts` owns that). Every write method takes the
 * caller's transaction handle `tx` so a balance mutation and its ledger
 * entry (and, for `terminationPayout`, its `leave.balance_payout` outbox
 * row) commit or roll back together (kernel `writeOutbox`, ADR-005).
 */
export class BalancesService {
  constructor(
    private readonly repo: BalancesRepository,
    private readonly genId: () => string,
  ) {}

  async getOrDefault(employeeId: string, leaveTypeId: string, year: number): Promise<LeaveBalanceRow> {
    const existing = await this.repo.findOne(employeeId, leaveTypeId, year)
    if (existing) return existing
    return { id: '', employeeId, leaveTypeId, entitled: Decimal.ZERO, taken: Decimal.ZERO, carriedOver: Decimal.ZERO, year }
  }

  ledgerHistory(employeeId: string, leaveTypeId: string): Promise<LedgerEntryRow[]> {
    return this.repo.listLedger(employeeId, leaveTypeId)
  }

  /**
   * Grants (creates, or tops up if a row already exists) `year`'s balance
   * for `employeeId`/`leaveType`. `employeeStartDate` drives pro-ration
   * (M5-2: "pro-ration for new joiners") — `null` when the employee's hire
   * date is unknown (this service accepts `employee.*` events best-effort;
   * see `employee-ref.consumer.ts`), which grants the FULL entitlement
   * rather than silently zeroing a real employee's leave.
   */
  async grantAnnual(tx: Queryable, employeeId: string, leaveType: LeaveTypeRow, year: number, employeeStartDate: string | null): Promise<LeaveBalanceRow> {
    const baseEntitlement = leaveType.entitlementDays ?? Decimal.ZERO
    const entitled = employeeStartDate ? prorate(baseEntitlement, employeeStartDate, year) : baseEntitlement

    const existing = await this.repo.findOne(employeeId, leaveType.id, year)
    const row = existing
      ? await this.mustUpdate(tx, existing.id, { entitled })
      : await this.repo.insert(tx, { id: this.genId(), employeeId, leaveTypeId: leaveType.id, entitled, taken: Decimal.ZERO, carriedOver: Decimal.ZERO, year })

    await this.repo.appendLedgerEntry(tx, {
      id: this.genId(),
      employeeId,
      leaveTypeId: leaveType.id,
      year,
      delta: entitled,
      reason: 'annual_grant',
      refId: null,
    })
    return row
  }

  /** Increments `taken` by `days` and appends the ledger entry — called on final-level approval (`approvals.service.ts`). Does not itself enforce sufficiency; the request-submission path (`requests.service.ts`) is where `LVE-010` is raised, against the balance as it stood at submission time. */
  async recordTaken(tx: Queryable, employeeId: string, leaveTypeId: string, year: number, days: string, refId: string): Promise<LeaveBalanceRow> {
    const balance = await this.getOrCreate(tx, employeeId, leaveTypeId, year)
    const updated = await this.mustUpdate(tx, balance.id, { taken: Decimal.add(balance.taken, days) })
    await this.repo.appendLedgerEntry(tx, { id: this.genId(), employeeId, leaveTypeId, year, delta: `-${days}`, reason: 'leave_taken', refId })
    return updated
  }

  /** Reverses a previously-recorded `taken` amount — cancellation of an already-approved request. */
  async reverseTaken(tx: Queryable, employeeId: string, leaveTypeId: string, year: number, days: string, refId: string): Promise<LeaveBalanceRow> {
    const balance = await this.getOrCreate(tx, employeeId, leaveTypeId, year)
    const updated = await this.mustUpdate(tx, balance.id, { taken: Decimal.subtract(balance.taken, days) })
    await this.repo.appendLedgerEntry(tx, { id: this.genId(), employeeId, leaveTypeId, year, delta: days, reason: 'cancelled', refId })
    return updated
  }

  /**
   * Year-end carry-over (M5-2: "carry-over rules ... default carry-over ON
   * for annual leave"). No-op — by design, not omission — when
   * `leaveType.carryOverEnabled` is false: only a type explicitly seeded
   * with carry-over on (the `annual` type, per the Supreme Court position;
   * see the migration's file header) rolls a balance forward at all.
   */
  async carryOverYearEnd(tx: Queryable, employeeId: string, leaveType: LeaveTypeRow, fromYear: number, toYear: number): Promise<LeaveBalanceRow | null> {
    if (!leaveType.carryOverEnabled) return null
    const fromBalance = await this.repo.findOne(employeeId, leaveType.id, fromYear)
    if (!fromBalance) return null
    const carryAmount = Decimal.clampNonNegative(available(fromBalance))

    const toExisting = await this.repo.findOne(employeeId, leaveType.id, toYear)
    const toRow = toExisting
      ? await this.mustUpdate(tx, toExisting.id, { carriedOver: carryAmount })
      : await this.repo.insert(tx, { id: this.genId(), employeeId, leaveTypeId: leaveType.id, entitled: Decimal.ZERO, taken: Decimal.ZERO, carriedOver: carryAmount, year: toYear })

    await this.repo.appendLedgerEntry(tx, { id: this.genId(), employeeId, leaveTypeId: leaveType.id, year: toYear, delta: carryAmount, reason: 'carry_over', refId: null })
    return toRow
  }

  /**
   * Termination payout (M5-2: "payout-on-termination calculation feeding
   * Payroll"; Statutory Spec §7: "Unused annual leave payout on
   * termination: mandatory for accrued entitlement (s.67)"). Publishes
   * `leave.balance_payout` in the SAME transaction as the balance write
   * (kernel `writeOutbox`, ADR-005) with the fixed roadmap payload shape
   * `{employeeId, leaveTypeCode, days, reason}`.
   *
   * Zero-balance is a legitimate outcome, not an error: an employee with no
   * unused leave produces no payout and no event — publishing a
   * `leave.balance_payout` for zero days would be a spurious payroll line.
   */
  async terminationPayout(tx: Queryable, employeeId: string, leaveType: LeaveTypeRow, year: number): Promise<{ days: string } | null> {
    const balance = await this.repo.findOne(employeeId, leaveType.id, year)
    if (!balance) return null
    const payoutDays = Decimal.clampNonNegative(available(balance))
    if (Decimal.compare(payoutDays, Decimal.ZERO) <= 0) return null

    // The payout consumes the balance: taken rises to entitled + carriedOver so `available()` reads zero afterward, and a second termination event (redelivered, not merely a duplicate `eventId` — see `employee-ref.consumer.ts`) cannot pay out the same balance twice.
    await this.mustUpdate(tx, balance.id, { taken: Decimal.add(balance.entitled, balance.carriedOver) })
    await this.repo.appendLedgerEntry(tx, { id: this.genId(), employeeId, leaveTypeId: leaveType.id, year, delta: `-${payoutDays}`, reason: 'termination_payout', refId: null })

    await writeOutbox(tx, 'leave', 'leave.balance_payout', {
      employeeId,
      leaveTypeCode: leaveType.code,
      days: payoutDays,
      reason: 'termination',
    })

    return { days: payoutDays }
  }

  /** Manual HR adjustment (`POST /balances/:employeeId/adjust`, M5-LEAVE.md §3 item 8): `delta` is signed — positive corrects a balance UP (e.g. an accrual the engine missed), negative corrects it DOWN. Always ledger-logged with `reason`, matching every other balance mutation in this service. */
  async adjust(tx: Queryable, employeeId: string, leaveTypeId: string, year: number, delta: string, reason: string): Promise<LeaveBalanceRow> {
    const balance = await this.getOrCreate(tx, employeeId, leaveTypeId, year)
    const updated = await this.mustUpdate(tx, balance.id, { taken: Decimal.subtract(balance.taken, delta) })
    await this.repo.appendLedgerEntry(tx, { id: this.genId(), employeeId, leaveTypeId, year, delta, reason, refId: null })
    return updated
  }

  /**
   * Projected balance at `asOfDate` (M5-5: "projected balance at a future
   * date"). Current available balance PLUS the monthly-accrual portion
   * still to come between now and `asOfDate` within the same year — the
   * only accrual mode this projects forward; `annual_grant`/`anniversary`
   * types are already fully granted for the current year the moment
   * `grantAnnual` runs, so there is nothing further to project for them
   * short of a full next-year forecast, which is out of this method's
   * scope.
   */
  async project(employeeId: string, leaveType: LeaveTypeRow, asOfDate: string, today: string): Promise<string> {
    const year = Number(asOfDate.slice(0, 4))
    const balance = await this.getOrDefault(employeeId, leaveType.id, year)
    const current = available(balance)
    if (leaveType.accrualMode !== 'monthly' || leaveType.entitlementDays === null) return current

    const monthsRemaining = this.wholeMonthsBetween(today, asOfDate)
    if (monthsRemaining <= 0) return current
    const monthlyAmount = Decimal.mulFractionRound(leaveType.entitlementDays, 1, MONTHS_PER_YEAR)
    const futureAccrual = Decimal.mulFractionRound(monthlyAmount, monthsRemaining, 1)
    return Decimal.add(current, futureAccrual)
  }

  private wholeMonthsBetween(fromIso: string, toIso: string): number {
    const from = new Date(`${fromIso}T00:00:00Z`)
    const to = new Date(`${toIso}T00:00:00Z`)
    const months = (to.getUTCFullYear() - from.getUTCFullYear()) * MONTHS_PER_YEAR + (to.getUTCMonth() - from.getUTCMonth())
    return Math.max(0, months)
  }

  private async getOrCreate(tx: Queryable, employeeId: string, leaveTypeId: string, year: number): Promise<LeaveBalanceRow> {
    const existing = await this.repo.findOne(employeeId, leaveTypeId, year)
    if (existing) return existing
    return this.repo.insert(tx, { id: this.genId(), employeeId, leaveTypeId, entitled: Decimal.ZERO, taken: Decimal.ZERO, carriedOver: Decimal.ZERO, year })
  }

  private async mustUpdate(tx: Queryable, id: string, patch: Partial<Pick<LeaveBalanceRow, 'entitled' | 'taken' | 'carriedOver'>>): Promise<LeaveBalanceRow> {
    const updated = await this.repo.update(tx, id, patch)
    if (!updated) throw new Error(`BalancesService: balance ${id} disappeared mid-transaction`)
    return updated
  }
}
