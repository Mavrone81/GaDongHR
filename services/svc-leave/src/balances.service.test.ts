import { randomUUID } from 'node:crypto'
import { BalancesRepository } from './balances.repository'
import { BalancesService, available, prorate, remainingMonthsInYear } from './balances.service'
import { FakeLeaveDb } from './testing/fake-db'
import type { LeaveTypeRow } from './leave-types.repository'

function setup() {
  const db = new FakeLeaveDb()
  const repo = new BalancesRepository(db.asPool())
  const service = new BalancesService(repo, () => randomUUID())
  return { db, repo, service }
}

async function withTx<T>(db: FakeLeaveDb, fn: (tx: ReturnType<FakeLeaveDb['connect']>) => Promise<T>): Promise<T> {
  const conn = db.connect()
  await conn.query('BEGIN')
  try {
    const result = await fn(conn)
    await conn.query('COMMIT')
    return result
  } catch (err) {
    await conn.query('ROLLBACK')
    throw err
  }
}

function annualType(overrides: Partial<LeaveTypeRow> = {}): LeaveTypeRow {
  return {
    id: 'type-annual',
    code: 'annual',
    nameI18n: { en: 'Annual Leave' },
    payMode: 'full',
    accrualMode: 'annual_grant',
    statutoryRuleKey: 'leave.annual.min_days',
    entitlementDays: '6',
    unit: 'days',
    payRatePercent: '100',
    carryOverEnabled: true,
    allowsHalfDay: true,
    allowsHourly: false,
    certTriggerDays: null,
    certTriggerRuleKey: null,
    citation: 'LPA s.30',
    active: true,
    ...overrides,
  }
}

describe('prorate / remainingMonthsInYear — mid-year joiner, boundary cases', () => {
  it('a joiner on 1 January gets the full entitlement (12/12)', () => {
    expect(remainingMonthsInYear('2026-01-01', 2026)).toBe(12)
    expect(prorate('6', '2026-01-01', 2026)).toBe('6')
  })

  it('a joiner on 1 July gets exactly half (6/12)', () => {
    expect(remainingMonthsInYear('2026-07-01', 2026)).toBe(6)
    expect(prorate('12', '2026-07-01', 2026)).toBe('6')
  })

  it('BOUNDARY: a joiner on 31 December (the last day of the year) still gets 1/12, not zero', () => {
    expect(remainingMonthsInYear('2026-12-31', 2026)).toBe(1)
    expect(prorate('12', '2026-12-31', 2026)).toBe('1')
  })

  it('BOUNDARY: a joiner on 1 December also gets 1/12 (same month-granularity bucket as 31 December)', () => {
    expect(remainingMonthsInYear('2026-12-01', 2026)).toBe(1)
  })

  it('a joiner from a prior year gets the full entitlement in the requested year (already employed)', () => {
    expect(remainingMonthsInYear('2020-03-15', 2026)).toBe(12)
  })

  it('a joiner whose start date is in a FUTURE year relative to the requested year gets zero', () => {
    expect(remainingMonthsInYear('2027-01-01', 2026)).toBe(0)
    expect(prorate('6', '2027-01-01', 2026)).toBe('0')
  })
})

describe('BalancesService.grantAnnual — pro-ration for new joiners', () => {
  it('grants the full entitlement for an employee already employed at year start', async () => {
    const { db, service } = setup()
    const row = await withTx(db, (tx) => service.grantAnnual(tx, 'emp-1', annualType(), 2026, '2020-01-01'))
    expect(row.entitled).toBe('6')
  })

  it('grants a prorated entitlement for a mid-year joiner', async () => {
    const { db, service } = setup()
    const row = await withTx(db, (tx) => service.grantAnnual(tx, 'emp-2', annualType({ entitlementDays: '12' }), 2026, '2026-07-01'))
    expect(row.entitled).toBe('6')
  })

  it('grants the full entitlement when the employee start date is unknown (best-effort employee.* consumption)', async () => {
    const { db, service } = setup()
    const row = await withTx(db, (tx) => service.grantAnnual(tx, 'emp-3', annualType(), 2026, null))
    expect(row.entitled).toBe('6')
  })

  it('re-granting updates entitled and appends another ledger entry (idempotent re-run of an annual grant job)', async () => {
    const { db, service } = setup()
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-4', annualType(), 2026, '2020-01-01'))
    const second = await withTx(db, (tx) => service.grantAnnual(tx, 'emp-4', annualType({ entitlementDays: '8' }), 2026, '2020-01-01'))
    expect(second.entitled).toBe('8')
    const history = await service.ledgerHistory('emp-4', 'type-annual')
    expect(history).toHaveLength(2)
    expect(history.every((e) => e.reason === 'annual_grant')).toBe(true)
  })
})

describe('BalancesService — half-day / hourly arithmetic is exact', () => {
  it('recording two half-day requests decrements taken by exactly 1, never 0.9999... or 1.0000000001', async () => {
    const { db, service } = setup()
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-5', annualType(), 2026, '2020-01-01'))
    await withTx(db, (tx) => service.recordTaken(tx, 'emp-5', 'type-annual', 2026, '0.5', 'req-1'))
    const balance = await withTx(db, (tx) => service.recordTaken(tx, 'emp-5', 'type-annual', 2026, '0.5', 'req-2'))
    expect(balance.taken).toBe('1')
    expect(available(balance)).toBe('5')
  })

  it('reversing a half-day taken amount (cancellation) restores the balance exactly', async () => {
    const { db, service } = setup()
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-6', annualType(), 2026, '2020-01-01'))
    await withTx(db, (tx) => service.recordTaken(tx, 'emp-6', 'type-annual', 2026, '0.5', 'req-3'))
    const restored = await withTx(db, (tx) => service.reverseTaken(tx, 'emp-6', 'type-annual', 2026, '0.5', 'req-3'))
    expect(restored.taken).toBe('0')
    expect(available(restored)).toBe('6')
  })

  it('hourly leave (1/8 day = 0.125) accumulates exactly across many small requests', async () => {
    const { db, service } = setup()
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-7', annualType(), 2026, '2020-01-01'))
    let balance = await withTx(db, (tx) => service.recordTaken(tx, 'emp-7', 'type-annual', 2026, '0.125', 'req-h1'))
    for (let i = 0; i < 7; i++) {
      // Sequential ledger appends must observe each other's committed state
      balance = await withTx(db, (tx) => service.recordTaken(tx, 'emp-7', 'type-annual', 2026, '0.125', `req-h${i + 2}`))
    }
    expect(balance.taken).toBe('1')
  })
})

describe('BalancesService — carry-over ON by default for annual leave', () => {
  it('leaveType.carryOverEnabled=true (the annual type\'s seeded default) rolls the unused balance into next year\'s carriedOver', async () => {
    const { db, service } = setup()
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-8', annualType(), 2025, '2020-01-01'))
    await withTx(db, (tx) => service.recordTaken(tx, 'emp-8', 'type-annual', 2025, '2', 'req-4'))
    // available = 6 - 2 = 4
    const carried = await withTx(db, (tx) => service.carryOverYearEnd(tx, 'emp-8', annualType(), 2025, 2026))
    expect(carried?.carriedOver).toBe('4')
  })

  it('a type with carryOverEnabled=false does not carry anything over (no-op, not zero-and-write)', async () => {
    const { db, service } = setup()
    const noCarry = annualType({ id: 'type-business', code: 'business', carryOverEnabled: false, statutoryRuleKey: null, citation: null })
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-9', noCarry, 2025, '2020-01-01'))
    const result = await withTx(db, (tx) => service.carryOverYearEnd(tx, 'emp-9', noCarry, 2025, 2026))
    expect(result).toBeNull()
  })
})

describe('BalancesService.terminationPayout — emits leave.balance_payout with the right day count', () => {
  it('an employee with 4 unused days produces a payout of exactly 4 and one outbox row', async () => {
    const { db, service } = setup()
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-10', annualType(), 2026, '2020-01-01'))
    await withTx(db, (tx) => service.recordTaken(tx, 'emp-10', 'type-annual', 2026, '2', 'req-5'))
    const payout = await withTx(db, (tx) => service.terminationPayout(tx, 'emp-10', annualType(), 2026))
    expect(payout?.days).toBe('4')

    const outboxRows = db.debugOutboxRows()
    const payoutEvents = outboxRows.filter((r) => r.topic === 'leave.balance_payout')
    expect(payoutEvents).toHaveLength(1)
    expect(payoutEvents[0]?.payload).toMatchObject({ employeeId: 'emp-10', leaveTypeCode: 'annual', days: '4', reason: 'termination' })
  })

  it('a fully-consumed balance (zero available) produces no payout and no event', async () => {
    const { db, service } = setup()
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-11', annualType(), 2026, '2020-01-01'))
    await withTx(db, (tx) => service.recordTaken(tx, 'emp-11', 'type-annual', 2026, '6', 'req-6'))
    const payout = await withTx(db, (tx) => service.terminationPayout(tx, 'emp-11', annualType(), 2026))
    expect(payout).toBeNull()
    expect(db.debugOutboxRows().filter((r) => r.topic === 'leave.balance_payout')).toHaveLength(0)
  })

  it('an over-drawn balance (negative available) never pays out a negative amount', async () => {
    const { db, service } = setup()
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-12', annualType(), 2026, '2020-01-01'))
    // taken exceeds entitled — allowed at the balance layer (insufficiency is enforced at request-submission time, not here).
    await withTx(db, (tx) => service.recordTaken(tx, 'emp-12', 'type-annual', 2026, '9', 'req-7'))
    const payout = await withTx(db, (tx) => service.terminationPayout(tx, 'emp-12', annualType(), 2026))
    expect(payout).toBeNull()
  })
})

describe('BalancesService — ledger sums always equal the balance', () => {
  it('summing every ledger delta for an employee/type equals entitled + carriedOver - taken', async () => {
    const { db, repo, service } = setup()
    await withTx(db, (tx) => service.grantAnnual(tx, 'emp-13', annualType(), 2026, '2020-01-01'))
    await withTx(db, (tx) => service.recordTaken(tx, 'emp-13', 'type-annual', 2026, '2.5', 'req-8'))
    await withTx(db, (tx) => service.reverseTaken(tx, 'emp-13', 'type-annual', 2026, '0.5', 'req-8'))

    const history = await service.ledgerHistory('emp-13', 'type-annual')
    const summed = history.reduce((acc, entry) => acc + Number(entry.delta), 0)
    // 6 (grant) - 2.5 (taken) + 0.5 (reversed) = 4
    expect(summed).toBeCloseTo(4)

    const balance = await repo.findOne('emp-13', 'type-annual', 2026)
    expect(balance && available(balance)).toBe('4')
  })
})
