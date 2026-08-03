import type { Queryable } from '@gadong/kernel'
import type { ConfigClient } from './config-client'
import { OnboardingTaskRepository } from './onboarding-task.repository'
import type { EmploymentType } from './employee.repository'
import type { OnboardingTaskRow, TaskKey } from './onboarding-task.repository'
import { checklistTaskNotFound, ssoTaskBlockedWithoutSsoNumber } from './onboarding-errors'

/** The statutory figure this whole module exists to demonstrate is never hard-coded (task brief): `sso.registration.deadline_days`, Statutory Spec §5 / SSA s.34. */
export const SSO_DEADLINE_RULE_KEY = 'sso.registration.deadline_days'

/**
 * How many days BEFORE the SSO task's due date it escalates — `due - 7`,
 * matching the PRD M1-2 acceptance criterion's literal "D+30 ... escalates
 * ... at D+23" (30 − 7 = 23). This is product/UX policy (when to nag
 * harder), not a Thai statutory figure — unlike `sso.registration.
 * deadline_days` (SSA s.34, a legal deadline `svc-config` governs), no law
 * says escalation must happen exactly 7 days early, so it is not a
 * `svc-config` rule key. The AC's own numbers (30, 23) are only ever
 * produced here as `deadlineDays - ESCALATION_LEAD_DAYS`, with
 * `deadlineDays` itself always coming from `ConfigClient` — never a literal
 * `30` anywhere in this file.
 */
export const ESCALATION_LEAD_DAYS = 7

/**
 * Fixed per employment type (PRD M1-2: "Configurable checklist per employee
 * type"). `probation_review` is omitted for `contract` — Thai fixed-term
 * contracts do not carry a probation period the way indefinite monthly/
 * daily/hourly employment does; every type still gets `sso_registration`
 * (SSA registration applies regardless of employment type).
 */
const CHECKLIST_TEMPLATE: Record<EmploymentType, TaskKey[]> = {
  monthly: ['personal_data_collection', 'document_upload', 'contract_generation', 'pdpa_consent', 'sso_registration', 'probation_review'],
  daily: ['personal_data_collection', 'document_upload', 'contract_generation', 'pdpa_consent', 'sso_registration', 'probation_review'],
  hourly: ['personal_data_collection', 'document_upload', 'contract_generation', 'pdpa_consent', 'sso_registration', 'probation_review'],
  contract: ['personal_data_collection', 'document_upload', 'contract_generation', 'pdpa_consent', 'sso_registration'],
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface TaskWithEscalation extends OnboardingTaskRow {
  /** `null` for every task key except `sso_registration`, which is the only one with a defined escalation rule (task brief AC). */
  escalateAt: string | null
}

/**
 * Generates and manages the onboarding checklist (M1-2). No SQL beyond what
 * `OnboardingTaskRepository` does; this class owns the checklist
 * COMPOSITION (which tasks, which due dates) and the one blocking rule
 * (`sso_registration` cannot complete without a real SSO number).
 */
export class ChecklistService {
  constructor(
    private readonly repo: OnboardingTaskRepository,
    private readonly configClient: ConfigClient,
  ) {}

  /** Fetches the SSO registration deadline from `svc-config` — the one external I/O this class does, done up front (before any DB transaction opens) matching `svc-docs`'s prepare/commit split for the same reason: an in-flight HTTP call must not hold a DB connection hostage. */
  async resolveSsoDeadlineDays(): Promise<number> {
    return this.configClient.getNumericRule(SSO_DEADLINE_RULE_KEY)
  }

  /** Due dates for every task in the template for `employmentType`, given `startDate` (D) and the already-resolved `ssoDeadlineDays`. Pure — no I/O — so `EmployeeService` can compute this once and reuse it inside a transaction without any further await. */
  planTasks(employmentType: EmploymentType, startDate: string, ssoDeadlineDays: number): Array<{ taskKey: TaskKey; dueDate: string }> {
    return CHECKLIST_TEMPLATE[employmentType].map((taskKey) => ({
      taskKey,
      dueDate: taskKey === 'sso_registration' ? addDays(startDate, ssoDeadlineDays) : startDate,
    }))
  }

  /** Inserts the planned tasks within `tx` — the same transaction as the employee row and its `employee.created` outbox event. */
  async createTasks(tx: Queryable, employeeId: string, plan: Array<{ taskKey: TaskKey; dueDate: string }>): Promise<OnboardingTaskRow[]> {
    const rows: OnboardingTaskRow[] = []
    for (const { taskKey, dueDate } of plan) {
      rows.push(await this.repo.insert(tx, { employeeId, taskKey, dueDate }))
    }
    return rows
  }

  /** Looks up a single task by id — used by the controller when a caller (e.g. an HR console that already has the employee loaded) omits `ssoNumberPresent` and the employee id must be recovered from the task itself. */
  async findTask(taskId: string): Promise<OnboardingTaskRow | null> {
    return this.repo.findById(taskId)
  }

  async listForEmployee(employeeId: string): Promise<TaskWithEscalation[]> {
    const rows = await this.repo.findByEmployeeId(employeeId)
    return rows.map((row) => ({
      ...row,
      escalateAt: row.taskKey === 'sso_registration' ? addDays(row.dueDate, -ESCALATION_LEAD_DAYS) : null,
    }))
  }

  /** Whether `today` (ISO date) has reached or passed the `sso_registration` task's escalation date — the AC's "escalates at D+23" as a queryable fact, not a side effect (a notification job elsewhere polls this; out of this task's scope). `false` when there is no such task (e.g. contract employees have none). */
  async isSsoTaskEscalated(employeeId: string, today: string): Promise<boolean> {
    const tasks = await this.listForEmployee(employeeId)
    const sso = tasks.find((t) => t.taskKey === 'sso_registration')
    if (!sso || sso.status === 'completed' || sso.escalateAt === null) return false
    return today >= sso.escalateAt
  }

  /**
   * `POST /checklist/tasks/:taskId/complete`. `sso_registration` cannot
   * complete without a non-blank SSO number on file (M1-ONBOARDING §3.1 row
   * 7) — `ssoNumberPresent` is supplied by the caller (`EmployeeService`,
   * which alone can decrypt `sso_number` to check), never computed here;
   * this method has no crypto dependency.
   */
  async completeTask(tx: Queryable, taskId: string, ssoNumberPresent: boolean): Promise<OnboardingTaskRow> {
    const task = await this.repo.findById(taskId)
    if (!task) throw checklistTaskNotFound(taskId)
    if (task.taskKey === 'sso_registration' && !ssoNumberPresent) throw ssoTaskBlockedWithoutSsoNumber()

    const completed = await this.repo.markCompleted(tx, taskId)
    if (!completed) throw checklistTaskNotFound(taskId) // lost a race with a concurrent completion/deletion
    return completed
  }

  async allComplete(employeeId: string): Promise<boolean> {
    const tasks = await this.repo.findByEmployeeId(employeeId)
    return tasks.length > 0 && tasks.every((t) => t.status === 'completed')
  }
}
