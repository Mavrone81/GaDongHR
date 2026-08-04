import { CryptoClient, idempotent } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { bahtToSatang } from './money'
import { RULE_KEYS, StatutoryResolver } from './statutory'
import type { ConfigClient } from './config-client'
import { PayInputsRepository } from './pay-inputs.repository'
import { RefsRepository } from './refs.repository'
import { encryptMoneyFields } from './money-crypto'

/**
 * Inbound events (roadmap event catalog). Every handler runs inside the
 * kernel's `idempotent()`, which dedupes on `payroll.processed_events` in
 * the SAME transaction as the effect — triple delivery of one event id
 * produces exactly one payslip line (XC-EVENTS).
 *
 * FOUR CONSUMERS, ONE OF WHICH CARRIES THE MODULE'S SHARPEST CORRECTNESS
 * PROPERTY:
 *
 *  - `timesheet.locked` / `timesheet.unlocked` — the version a run binds
 *    to, and the version that makes a calculated run stale (PAY-030).
 *  - `leave.balance_payout` — an unused-leave payout. Whether it is taxable
 *    and whether it enters the SSO wage base are resolved FROM CONFIG, not
 *    decided here, because both are legal classifications rather than
 *    engineering choices (and both are listed in this module's report as
 *    figures counsel should confirm).
 *  - `claim.approved_for_payroll` — an expense reimbursement. The event
 *    carries `taxable:false` and `ssoWageBase:false` EXPLICITLY, and this
 *    consumer honours those flags verbatim: it does not consult config, and
 *    it does not derive anything from `claimType`. `svc-claims` put those
 *    booleans on the payload precisely so that M7 could not miss them by
 *    omission, and the row they are written to is `notNull` with no
 *    default. A reimbursement that entered the tax base would over-tax the
 *    employee; one that entered the SSO wage base would make the employer's
 *    สปส.1-10 filing wrong.
 *  - `employee.created`/`updated`/`terminated` — the read model, including
 *    the province that decides a minimum-wage floor and the start date that
 *    decides a severance tier.
 */

export interface TimesheetLockedEvent {
  topic: 'timesheet.locked' | 'timesheet.unlocked'
  eventId: string
  payload: { periodId: string; lockVersion: number; lockedBy?: string }
}

export interface LeaveBalancePayoutEvent {
  topic: 'leave.balance_payout'
  eventId: string
  payload: { employeeId: string; leaveTypeCode: string; days: string; reason: string; amountThb: string; period: string; requestId?: string }
}

export interface ClaimApprovedForPayrollEvent {
  topic: 'claim.approved_for_payroll'
  eventId: string
  payload: {
    claimId: string
    employeeId: string
    amountThb: string
    claimType: string
    /** Both flags are honoured verbatim — see the class doc. */
    taxable: false
    ssoWageBase: false
    period: string
  }
}

export interface EmployeeEvent {
  topic: 'employee.created' | 'employee.updated' | 'employee.terminated'
  eventId: string
  payload: {
    id: string
    empCode?: string
    status?: string
    provinceCode?: string
    startDate?: string
    preferredLang?: string
    orgUnitId?: string
    employmentType?: string
    terminationDate?: string
    reasonCategory?: string
    lastWorkingDay?: string
    noticeGiven?: boolean
    statutoryCause?: string
    statutoryCitation?: string
  }
}

const SCHEMA = 'payroll'

export class EventConsumersService {
  constructor(
    private readonly refs: RefsRepository,
    private readonly payInputs: PayInputsRepository,
    private readonly config: ConfigClient,
    private readonly crypto: CryptoClient,
    private readonly newId: () => string,
  ) {}

  async handleTimesheetLock(tx: Queryable, event: TimesheetLockedEvent): Promise<'duplicate' | 'ok'> {
    const result = await idempotent(tx, SCHEMA, event.eventId, async () => {
      await this.refs.upsertTimesheetLock(tx, {
        period: event.payload.periodId,
        lockVersion: event.payload.lockVersion,
        locked: event.topic === 'timesheet.locked',
        lockedBy: event.payload.lockedBy ?? null,
      })
      return 'ok' as const
    })
    return result
  }

  async handleLeavePayout(tx: Queryable, event: LeaveBalancePayoutEvent): Promise<'duplicate' | 'ok'> {
    return idempotent(tx, SCHEMA, event.eventId, async () => {
      // The classification is statutory, so it is resolved as of the
      // period being paid rather than decided in this file.
      const resolver = new StatutoryResolver(this.config, `${event.payload.period}-01`)
      const [taxable, ssoWageBase] = await Promise.all([
        resolver.requiredFlag(RULE_KEYS.leavePayoutTaxable),
        resolver.requiredFlag(RULE_KEYS.leavePayoutSsoWageBase),
      ])
      await this.queueInput(tx, {
        employeeId: event.payload.employeeId,
        period: event.payload.period,
        source: 'leave_payout',
        sourceRef: event.payload.requestId ?? `${event.payload.employeeId}:${event.payload.leaveTypeCode}:${event.payload.period}`,
        kind: `leave_payout:${event.payload.leaveTypeCode}`,
        amountThb: event.payload.amountThb,
        taxable: taxable.value,
        ssoWageBase: ssoWageBase.value,
        meta: { days: event.payload.days, reason: event.payload.reason, oneOff: true },
      })
      return 'ok' as const
    })
  }

  async handleClaimApproved(tx: Queryable, event: ClaimApprovedForPayrollEvent): Promise<'duplicate' | 'ok'> {
    return idempotent(tx, SCHEMA, event.eventId, async () => {
      await this.queueInput(tx, {
        employeeId: event.payload.employeeId,
        period: event.payload.period,
        source: 'claim_reimbursement',
        sourceRef: event.payload.claimId,
        kind: `reimbursement:${event.payload.claimType}`,
        amountThb: event.payload.amountThb,
        // Verbatim from the producing event. No config lookup, no
        // derivation from `claimType`, no default — see the class doc.
        taxable: event.payload.taxable,
        ssoWageBase: event.payload.ssoWageBase,
        meta: { claimType: event.payload.claimType, oneOff: true },
      })
      return 'ok' as const
    })
  }

  async handleEmployee(tx: Queryable, event: EmployeeEvent): Promise<'duplicate' | 'ok'> {
    return idempotent(tx, SCHEMA, event.eventId, async () => {
      const p = event.payload
      await this.refs.upsertEmployee(tx, {
        employeeId: p.id,
        empCode: p.empCode ?? null,
        status: event.topic === 'employee.terminated' ? 'terminated' : (p.status ?? 'active'),
        provinceCode: p.provinceCode ?? null,
        startDate: p.startDate ?? null,
        preferredLang: p.preferredLang ?? null,
        orgUnitId: p.orgUnitId ?? null,
        employmentType: p.employmentType ?? null,
      })

      if (event.topic === 'employee.terminated' && p.terminationDate !== undefined) {
        await this.refs.upsertTermination(tx, {
          employeeId: p.id,
          terminationDate: p.terminationDate,
          lastWorkingDay: p.lastWorkingDay ?? p.terminationDate,
          reasonCategory: p.reasonCategory ?? 'unspecified',
          // The event does not carry the s.119 cause — a human records it
          // through the final-pay screen. Both columns move together or
          // the DB CHECK refuses the row.
          statutoryCause: p.statutoryCause ?? null,
          statutoryCitation: p.statutoryCitation ?? null,
          noticeGiven: p.noticeGiven ?? false,
        })
      }
      return 'ok' as const
    })
  }

  private async queueInput(
    tx: Queryable,
    input: {
      employeeId: string
      period: string
      source: 'leave_payout' | 'claim_reimbursement'
      sourceRef: string
      kind: string
      amountThb: string
      taxable: boolean
      ssoWageBase: boolean
      meta: Record<string, unknown>
    },
  ): Promise<void> {
    const id = this.newId()
    const cipher = await encryptMoneyFields(this.crypto, id, { amount: bahtToSatang(input.amountThb) })
    const buf = cipher.get('amount')
    if (buf === undefined) throw new Error('EventConsumersService: svc-crypto did not return amount ciphertext')
    await this.payInputs.insert(tx, {
      id,
      employeeId: input.employeeId,
      period: input.period,
      source: input.source,
      sourceRef: input.sourceRef,
      kind: input.kind,
      amount: buf,
      taxable: input.taxable,
      ssoWageBase: input.ssoWageBase,
      direction: 'earning',
      meta: input.meta,
    })
  }
}
