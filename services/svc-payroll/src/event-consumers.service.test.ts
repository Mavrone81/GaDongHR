import { randomUUID } from 'node:crypto'
import { CryptoClient } from '@gadong/kernel'
import { decryptMoney } from './money-crypto'
import { satangToBaht } from './money'
import { EventConsumersService } from './event-consumers.service'
import { PayInputsRepository } from './pay-inputs.repository'
import { RefsRepository } from './refs.repository'
import { FakePayrollDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { seededConfig } from './testing/statutory-fixture'

/**
 * The four inbound consumers. The one that carries the module's sharpest
 * correctness property is `claim.approved_for_payroll`: `svc-claims` puts
 * `taxable:false` and `ssoWageBase:false` on the payload explicitly so M7
 * cannot miss them by omission, and this consumer must honour them
 * VERBATIM — no config lookup, no derivation from `claimType`, no default.
 */

function harness() {
  const db = new FakePayrollDb()
  const tx = db.connect()
  const config = seededConfig()
  const crypto = new CryptoClient(fakeCryptoTransport())
  const refs = new RefsRepository(db.asPool())
  const payInputs = new PayInputsRepository(db.asPool())
  const service = new EventConsumersService(refs, payInputs, config, crypto, () => randomUUID())
  return { db, tx, config, crypto, refs, payInputs, service }
}

const EMPLOYEE = '33333333-3333-4333-8333-333333333333'

describe('timesheet.locked / timesheet.unlocked', () => {
  // `periodId` is svc-timesheet's own period-row UUID — never payroll's
  // 'YYYY-MM' concept — so every fixture below uses a realistic
  // (non-'YYYY-MM'-shaped) UUID for it, matching the real wire payload
  // `period.service.ts`'s `writeOutbox` call produces, and asserts that the
  // stored `period` is derived from `dateRange.from` instead.
  const PERIOD_ID = '11111111-1111-4111-8111-111111111111'
  const DATE_RANGE = { from: '2026-10-01', to: '2026-10-31' }

  it('records the version a run may bind to, keyed on the calendar-month code derived from dateRange, not the foreign periodId', async () => {
    const h = harness()
    await h.service.handleTimesheetLock(h.tx, {
      topic: 'timesheet.locked',
      eventId: 'evt-1',
      payload: { periodId: PERIOD_ID, dateRange: DATE_RANGE, lockVersion: 7, lockedBy: EMPLOYEE },
    })
    expect(await h.refs.findTimesheetLock('2026-10', h.tx)).toMatchObject({ period: '2026-10', lockVersion: 7, locked: true })
  })

  it('an unlock flips the flag and bumps the version — which is what makes a bound run stale', async () => {
    const h = harness()
    await h.service.handleTimesheetLock(h.tx, {
      topic: 'timesheet.locked',
      eventId: 'e1',
      payload: { periodId: PERIOD_ID, dateRange: DATE_RANGE, lockVersion: 7 },
    })
    await h.service.handleTimesheetLock(h.tx, {
      topic: 'timesheet.unlocked',
      eventId: 'e2',
      payload: { periodId: PERIOD_ID, dateRange: DATE_RANGE, lockVersion: 8 },
    })
    expect(await h.refs.findTimesheetLock('2026-10', h.tx)).toMatchObject({ lockVersion: 8, locked: false })
  })

  it('TRIPLE DELIVERY of one event id produces exactly one effect (XC-EVENTS)', async () => {
    const h = harness()
    const event = {
      topic: 'timesheet.locked' as const,
      eventId: 'same-id',
      payload: { periodId: PERIOD_ID, dateRange: DATE_RANGE, lockVersion: 7 },
    }
    expect(await h.service.handleTimesheetLock(h.tx, event)).toBe('ok')
    expect(await h.service.handleTimesheetLock(h.tx, event)).toBe('duplicate')
    expect(await h.service.handleTimesheetLock(h.tx, event)).toBe('duplicate')
  })

  it('rejects a dateRange.from that is not a plain YYYY-MM-DD date, rather than silently storing a garbage period code', async () => {
    const h = harness()
    await expect(
      h.service.handleTimesheetLock(h.tx, {
        topic: 'timesheet.locked',
        eventId: 'evt-bad',
        payload: { periodId: PERIOD_ID, dateRange: { from: 'not-a-date', to: '2026-10-31' }, lockVersion: 1 },
      }),
    ).rejects.toThrow(/dateRange.from must be 'YYYY-MM-DD'/)
  })
})

describe('claim.approved_for_payroll — a reimbursement never enters the tax or SSO wage base', () => {
  const event = {
    topic: 'claim.approved_for_payroll' as const,
    eventId: 'claim-evt-1',
    payload: {
      claimId: 'claim-1',
      employeeId: EMPLOYEE,
      amountThb: '8000.00',
      claimType: 'travel',
      taxable: false as const,
      ssoWageBase: false as const,
      period: '2026-10',
    },
  }

  it('queues the amount with BOTH flags false, exactly as the producing event stated them', async () => {
    const h = harness()
    await h.service.handleClaimApproved(h.tx, event)

    const [input] = await h.payInputs.listOutstanding(EMPLOYEE, '2026-10', h.tx)
    expect(input).toMatchObject({ source: 'claim_reimbursement', sourceRef: 'claim-1', taxable: false, ssoWageBase: false, direction: 'earning' })
  })

  it('the amount is encrypted before it reaches the database', async () => {
    const h = harness()
    await h.service.handleClaimApproved(h.tx, event)
    const stored = h.db.debugTable('pay_input')[0]
    const raw = Buffer.concat(Object.values(stored ?? {}).filter((v): v is Buffer => Buffer.isBuffer(v))).toString('utf8')
    expect(raw).not.toContain('8000')

    const [input] = await h.payInputs.listOutstanding(EMPLOYEE, '2026-10', h.tx)
    if (input === undefined) throw new Error('no input')
    expect(satangToBaht(await decryptMoney(h.crypto, input.id, 'amount', input.amount, 'test'))).toBe('8000.00')
  })

  it('the consumer does NOT consult config for the classification — the event is authoritative', async () => {
    const h = harness()
    await h.service.handleClaimApproved(h.tx, event)
    expect(h.config.requests).toHaveLength(0)
  })

  it('a redelivered claim event pays once, not twice', async () => {
    const h = harness()
    expect(await h.service.handleClaimApproved(h.tx, event)).toBe('ok')
    expect(await h.service.handleClaimApproved(h.tx, event)).toBe('duplicate')
    expect(await h.payInputs.listOutstanding(EMPLOYEE, '2026-10', h.tx)).toHaveLength(1)
  })
})

describe('leave.balance_payout — the classification IS a statutory question, so it comes from config', () => {
  const event = {
    topic: 'leave.balance_payout' as const,
    eventId: 'leave-evt-1',
    payload: { employeeId: EMPLOYEE, leaveTypeCode: 'annual', days: '6', reason: 'termination', amountThb: '9000.00', period: '2026-10', requestId: 'req-1' },
  }

  it('queues the payout with the taxable / SSO flags the rule pack states', async () => {
    const h = harness()
    await h.service.handleLeavePayout(h.tx, event)
    const [input] = await h.payInputs.listOutstanding(EMPLOYEE, '2026-10', h.tx)
    expect(input).toMatchObject({ source: 'leave_payout', kind: 'leave_payout:annual', taxable: true, ssoWageBase: false })
    expect(input?.meta).toMatchObject({ days: '6', reason: 'termination', oneOff: true })
  })

  it('...and CHANGING the rule pack changes the classification, with no code change', async () => {
    const h = harness()
    h.config.amend('payroll.leave_payout.sso_wage_base', '2026-10-01', true)
    await h.service.handleLeavePayout(h.tx, event)
    const [input] = await h.payInputs.listOutstanding(EMPLOYEE, '2026-10', h.tx)
    expect(input?.ssoWageBase).toBe(true)
  })

  it('a missing classification rule FAILS the event rather than guessing', async () => {
    const h = harness()
    h.config.remove('payroll.leave_payout.taxable')
    await expect(h.service.handleLeavePayout(h.tx, event)).rejects.toMatchObject({ code: 'PAY-503' })
  })

  it('is idempotent on redelivery', async () => {
    const h = harness()
    expect(await h.service.handleLeavePayout(h.tx, event)).toBe('ok')
    expect(await h.service.handleLeavePayout(h.tx, event)).toBe('duplicate')
  })
})

describe('employee.* — the read model the engine cannot work without', () => {
  it('records the province (minimum wage), start date (severance tier) and language (payslip)', async () => {
    const h = harness()
    await h.service.handleEmployee(h.tx, {
      topic: 'employee.created',
      eventId: 'emp-1',
      payload: { id: EMPLOYEE, empCode: 'E-1', provinceCode: 'TH-10', startDate: '2020-01-01', preferredLang: 'th', employmentType: 'full_time' },
    })
    expect(await h.refs.findEmployee(EMPLOYEE, h.tx)).toMatchObject({
      provinceCode: 'TH-10',
      startDate: '2020-01-01',
      preferredLang: 'th',
      status: 'active',
    })
  })

  it('an update that omits a field keeps the known value — losing a province would silently lose the minimum-wage floor', async () => {
    const h = harness()
    await h.service.handleEmployee(h.tx, {
      topic: 'employee.created',
      eventId: 'emp-1',
      payload: { id: EMPLOYEE, provinceCode: 'TH-10', startDate: '2020-01-01', preferredLang: 'th' },
    })
    await h.service.handleEmployee(h.tx, { topic: 'employee.updated', eventId: 'emp-2', payload: { id: EMPLOYEE, preferredLang: 'en' } })

    expect(await h.refs.findEmployee(EMPLOYEE, h.tx)).toMatchObject({ provinceCode: 'TH-10', startDate: '2020-01-01', preferredLang: 'en' })
  })

  it('a termination writes both the status and the termination record the final-pay calculator needs', async () => {
    const h = harness()
    await h.service.handleEmployee(h.tx, {
      topic: 'employee.terminated',
      eventId: 'emp-3',
      payload: { id: EMPLOYEE, terminationDate: '2026-10-31', reasonCategory: 'redundancy', noticeGiven: true },
    })
    expect(await h.refs.findEmployee(EMPLOYEE, h.tx)).toMatchObject({ status: 'terminated' })
    expect(await h.refs.findTermination(EMPLOYEE, h.tx)).toMatchObject({
      terminationDate: '2026-10-31',
      reasonCategory: 'redundancy',
      noticeGiven: true,
      statutoryCause: null,
      statutoryCitation: null,
    })
  })

  it('a termination event with no date does not fabricate a termination record', async () => {
    const h = harness()
    await h.service.handleEmployee(h.tx, { topic: 'employee.terminated', eventId: 'emp-4', payload: { id: EMPLOYEE } })
    expect(await h.refs.findTermination(EMPLOYEE, h.tx)).toBeNull()
  })

  it('is idempotent on redelivery', async () => {
    const h = harness()
    const event = { topic: 'employee.created' as const, eventId: 'emp-1', payload: { id: EMPLOYEE } }
    expect(await h.service.handleEmployee(h.tx, event)).toBe('ok')
    expect(await h.service.handleEmployee(h.tx, event)).toBe('duplicate')
  })
})
