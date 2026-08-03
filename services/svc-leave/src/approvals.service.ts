import { writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { ApprovalsRepository } from './approvals.repository'
import type { ApprovalDecision, ApprovalStepRow } from './approvals.repository'
import type { BalancesService } from './balances.service'
import * as Decimal from './decimal'
import { approvalStepAlreadyDecided, approvalStepNotFound, leaveRequestNotFound, leaveTypeNotFound, notAuthorizedApprover } from './errors'
import type { LeaveTypesRepository } from './leave-types.repository'
import { datesArray } from './requests.repository'
import type { RequestsRepository } from './requests.repository'

/** A caller-supplied assignment of "who decides level N" — this service does not own org-chart/reporting-line data (that is M1's), so the ESS/HR caller submitting a request (or configuring a chain) supplies it explicitly. Levels with no assignment are decidable by anyone holding `leave.approve` (enforced by the controller's `@RequirePermission`), matching `approval_step.approver_id`'s nullability. */
export type ApproverAssignments = Record<number, string>

/**
 * Business logic behind the multi-level approval chain (M5-3) — no SQL
 * here (`approvals.repository.ts` owns that). `createChain` runs inside the
 * same transaction as `RequestsService.submit`'s insert (both are called
 * from the controller's one `withTransaction` block — see
 * `leave.controller.ts`), so a request is never left without its approval
 * steps.
 *
 * `decide()` is where delegation resolves (M5-3: "delegation for absent
 * approvers"; M5-LEAVE.md's test hook: "delegation approves when level-1
 * approver on leave themselves") and where the FINAL level's approval
 * publishes `leave.approved` and decrements the balance — both inside the
 * same transaction as the decision write.
 */
export class ApprovalsService {
  constructor(
    private readonly repo: ApprovalsRepository,
    private readonly requestsRepo: RequestsRepository,
    private readonly leaveTypesRepo: LeaveTypesRepository,
    private readonly balances: BalancesService,
    private readonly genId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Resolves the chain for `leaveTypeId`/`days` from `approval_level`
   * config (every level whose `minDays <= days` applies — "multi-level
   * approval chains by leave type and duration", M5-3) and inserts one
   * `approval_step` per qualifying level. A type with NO configured levels
   * gets a single default level-1 `manager` step — every request needs at
   * least one decision point, even before HR has configured a chain for
   * that type.
   */
  async createChain(tx: Queryable, subjectId: string, leaveTypeId: string, days: string, assignments: ApproverAssignments = {}): Promise<ApprovalStepRow[]> {
    const configuredLevels = await this.repo.listLevelsForType(leaveTypeId)
    const applicable = configuredLevels.filter((l) => Decimal.compare(days, l.minDays) >= 0)

    const levels: Array<{ level: number; approverRole: string }> =
      applicable.length > 0 ? applicable.map((l) => ({ level: l.level, approverRole: l.approverRole })) : [{ level: 1, approverRole: 'manager' }]

    const steps: ApprovalStepRow[] = []
    for (const level of levels) {
      // Sequential by design: each level's step is inserted in order; the chain is small (typically 1-3 levels) and this runs inside one transaction.
      const step = await this.repo.insertStep(tx, {
        id: this.genId(),
        subjectId,
        level: level.level,
        approverRole: level.approverRole,
        approverId: assignments[level.level] ?? null,
      })
      steps.push(step)
    }
    return steps
  }

  async listBySubject(subjectId: string): Promise<ApprovalStepRow[]> {
    return this.repo.listStepsBySubject(subjectId)
  }

  /**
   * `GET /approvals?status=pending` (M5-LEAVE.md §3 item 5, "Queue with
   * delegation view"): every undecided step this caller may act on —
   * assigned directly to them, unassigned (any `leave.approve` holder), or
   * delegated to them by an absent assigned approver. There is no efficient
   * "steps for this subject-list" query here because this service's
   * repositories only support equality WHERE clauses (see `testing/fake-db.ts`'s
   * header): this scans every request the caller could plausibly have a
   * stake in, which is acceptable at this service's target scale (a few
   * hundred concurrent pending requests per tenant, not millions).
   */
  async listPendingForApprover(approverId: string, today: string, allSubjectIds: string[]): Promise<ApprovalStepRow[]> {
    const pending: ApprovalStepRow[] = []
    for (const subjectId of allSubjectIds) {
      // Bounded by allSubjectIds, which the caller (controller) already scoped to "active" requests.
      const steps = await this.repo.listStepsBySubject(subjectId)
      for (const step of steps) {
        if (step.decision !== null) continue
        if (step.approverId === null || step.approverId === approverId) {
          pending.push(step)
          continue
        }
        // One delegation lookup per distinct assigned approver on an undecided step; bounded by the same bound as the outer loop.
        const delegations = await this.repo.listDelegationsForApprover(step.approverId)
        if (delegations.some((d) => d.delegateId === approverId && d.startsOn <= today && today <= d.endsOn)) {
          pending.push(step)
        }
      }
    }
    return pending
  }

  /**
   * Decides one step. Authorization: the step's ASSIGNED `approverId` (if
   * any) may decide it directly; otherwise an active delegate — an
   * `approver_delegation` row for that `approverId` whose date range covers
   * `today` — may decide in their place. A step with no assigned
   * `approverId` at all is decidable by any caller (already gated at the
   * controller by `leave.approve`).
   *
   * On the LAST unresolved level's approval, finalizes the request:
   * balance is decremented (`BalancesService.recordTaken`) and
   * `leave.approved` publishes — both in this same transaction. A
   * rejection at ANY level short-circuits the whole chain: the request
   * becomes `rejected` immediately, no further levels are asked.
   */
  async decide(tx: Queryable, stepId: string, decidingUserId: string, decision: ApprovalDecision, comment: string | null, today: string): Promise<ApprovalStepRow> {
    const step = await this.repo.findStepById(stepId)
    if (!step) throw approvalStepNotFound(stepId)
    if (step.decision !== null) throw approvalStepAlreadyDecided(stepId)

    await this.assertAuthorized(step, decidingUserId, today)

    const decided = await this.repo.decideStep(tx, stepId, decision, decidingUserId, comment, this.now())
    if (!decided) throw approvalStepNotFound(stepId)

    if (decision === 'rejected') {
      await this.requestsRepo.updateStatus(tx, step.subjectId, 'rejected')
      return decided
    }

    const remaining = (await this.repo.listStepsBySubject(step.subjectId)).filter((s) => s.id !== stepId && s.decision === null)
    if (remaining.length === 0) {
      await this.finalizeApproval(tx, step.subjectId)
    }
    return decided
  }

  private async assertAuthorized(step: ApprovalStepRow, decidingUserId: string, today: string): Promise<void> {
    if (step.approverId === null || step.approverId === decidingUserId) return

    const delegations = await this.repo.listDelegationsForApprover(step.approverId)
    const activeDelegate = delegations.some((d) => d.delegateId === decidingUserId && d.startsOn <= today && today <= d.endsOn)
    if (!activeDelegate) throw notAuthorizedApprover(step.id)
  }

  private async finalizeApproval(tx: Queryable, requestId: string): Promise<void> {
    const request = await this.requestsRepo.findById(requestId)
    if (!request) throw leaveRequestNotFound(requestId)
    const leaveType = await this.leaveTypesRepo.findById(request.leaveTypeId)
    if (!leaveType) throw leaveTypeNotFound(request.leaveTypeId)

    const updated = await this.requestsRepo.updateStatus(tx, requestId, 'approved')
    if (!updated) throw leaveRequestNotFound(requestId)

    const year = Number(request.startDate.slice(0, 4))
    await this.balances.recordTaken(tx, request.employeeId, request.leaveTypeId, year, request.days, request.id)

    await writeOutbox(tx, 'leave', 'leave.approved', {
      requestId: request.id,
      employeeId: request.employeeId,
      leaveTypeCode: leaveType.code,
      dates: datesArray(request),
      days: request.days,
      payMode: leaveType.payMode,
    })
  }
}
