import { AuditEmitter } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { ProbationRepository } from './probation.repository'
import type { ProbationOutcome, ProbationRow } from './probation.repository'
import { EmployeeRepository } from './employee.repository'
import { EmployeeService } from './employee.service'
import { employeeNotFound, extendRequiresNewEndDate, noOpenProbation, terminationReasonRequired } from './onboarding-errors'

/**
 * Alert lead times from PRD M1-5's own acceptance criterion ("Probation end
 * alerts to manager and HR at −14 and −7 days") — literal AC numbers, not a
 * Thai statutory figure `svc-config` governs (unlike `sso.registration.
 * deadline_days`, no law fixes when a probation reminder must fire), so
 * these are fixed constants here rather than a config lookup — matching
 * `ChecklistService.ESCALATION_LEAD_DAYS`'s same reasoning.
 */
export const PROBATION_ALERT_DAYS_FIRST = 14
export const PROBATION_ALERT_DAYS_SECOND = 7

/** Days of service law treats as the severance-eligibility floor (Statutory Spec §7 / LPA s.118) — this service only computes the boolean flag; the severance AMOUNT is M7 payroll's job. */
const SEVERANCE_ELIGIBLE_SERVICE_DAYS = 120

export type AlertLevel = 'none' | 'due_14' | 'due_7'

export interface ProbationDecisionInput {
  outcome: ProbationOutcome
  /** Required (and only meaningful) for `outcome: 'extend'`. */
  newEndDate?: string
  /** Required (and only meaningful) for `outcome: 'terminate'` — feeds `EmployeeService.terminateWithinTx`'s `employee.terminated` event. */
  reasonCategory?: string
}

export interface ProbationDecisionResult {
  probation: ProbationRow
  /** Only set for `outcome: 'terminate'` — whether the ≥120-day severance rule applies (PRD M1-5); the actual calculation is M7's. */
  severanceApplicable?: boolean
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00.000Z`).getTime()
  const to = new Date(`${toIso}T00:00:00.000Z`).getTime()
  return Math.round((to - from) / 86_400_000)
}

/**
 * Business logic behind `POST /employees/:id/probation/decision` (M1-5).
 * `EmployeeService` is a dependency (not the other way round) so `terminate`
 * can drive the SAME lifecycle transition, guard, event and audit path a
 * direct `POST /employees/:id/transition` would (`terminateWithinTx`) —
 * there is exactly one place `employee.terminated` is ever published.
 */
export class ProbationService {
  constructor(
    private readonly probationRepo: ProbationRepository,
    private readonly employeeRepo: EmployeeRepository,
    private readonly employeeService: EmployeeService,
    private readonly audit: AuditEmitter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private today(): string {
    return this.now().toISOString().slice(0, 10)
  }

  /** Which effective end date alerts are computed against — the ORIGINAL `endDate` unless the probation was already `extend`ed, in which case the extension date supersedes it. */
  private effectiveEndDate(probation: ProbationRow): string {
    return probation.extendedTo ?? probation.endDate
  }

  /** `'due_14'`/`'due_7'` exactly on the day the countdown reaches that many days out; `'none'` otherwise (including once decided). */
  alertLevel(probation: ProbationRow, today: string = this.today()): AlertLevel {
    if (probation.outcome !== null) return 'none'
    const daysRemaining = daysBetween(today, this.effectiveEndDate(probation))
    if (daysRemaining === PROBATION_ALERT_DAYS_FIRST) return 'due_14'
    if (daysRemaining === PROBATION_ALERT_DAYS_SECOND) return 'due_7'
    return 'none'
  }

  async findByEmployeeId(employeeId: string): Promise<ProbationRow | null> {
    return this.probationRepo.findByEmployeeId(employeeId)
  }

  async decide(tx: Queryable, employeeId: string, input: ProbationDecisionInput, actorId: string, actorRole: string): Promise<ProbationDecisionResult> {
    const probation = await this.probationRepo.findByEmployeeId(employeeId)
    if (!probation || probation.outcome !== null) throw noOpenProbation(employeeId)

    const decidedAt = this.now().toISOString()

    if (input.outcome === 'extend') {
      if (!input.newEndDate) throw extendRequiresNewEndDate()
      const updated = await this.probationRepo.decide(tx, probation.id, 'extend', decidedAt, input.newEndDate)
      if (!updated) throw noOpenProbation(employeeId)
      await this.auditDecision(tx, updated, actorId, actorRole)
      return { probation: updated }
    }

    if (input.outcome === 'terminate') {
      if (!input.reasonCategory || input.reasonCategory.trim().length === 0) throw terminationReasonRequired()
      const employee = await this.employeeRepo.findById(employeeId)
      if (!employee) throw employeeNotFound(employeeId)
      const severanceApplicable = daysBetween(employee.startDate, this.today()) >= SEVERANCE_ELIGIBLE_SERVICE_DAYS

      // Same lifecycle path a direct POST /employees/:id/transition would
      // take — one place `employee.terminated` is ever published.
      await this.employeeService.terminateWithinTx(tx, employeeId, input.reasonCategory, actorId, actorRole)

      const updated = await this.probationRepo.decide(tx, probation.id, 'terminate', decidedAt, null)
      if (!updated) throw noOpenProbation(employeeId)
      await this.auditDecision(tx, updated, actorId, actorRole)
      return { probation: updated, severanceApplicable }
    }

    // confirm
    const updated = await this.probationRepo.decide(tx, probation.id, 'confirm', decidedAt, null)
    if (!updated) throw noOpenProbation(employeeId)
    await this.auditDecision(tx, updated, actorId, actorRole)
    return { probation: updated }
  }

  private async auditDecision(tx: Queryable, probation: ProbationRow, actorId: string, actorRole: string): Promise<void> {
    await this.audit.emit(tx, 'onboarding', {
      actorId, actorRole, action: 'probation.decided', entity: 'probation', entityId: probation.id, after: { outcome: probation.outcome },
    })
  }
}
