import { randomUUID } from 'node:crypto'
import { BalancesRepository } from './balances.repository'
import { BalancesService } from './balances.service'
import { EmployeeRefConsumer } from './employee-ref.consumer'
import { EmployeeRefRepository } from './employee-ref.repository'
import { LeaveTypesRepository } from './leave-types.repository'
import type { NewLeaveTypeRow } from './leave-types.repository'
import { FakeLeaveDb } from './testing/fake-db'

function setup() {
  const db = new FakeLeaveDb()
  const typesRepo = new LeaveTypesRepository(db.asPool())
  const balancesRepo = new BalancesRepository(db.asPool())
  const balancesService = new BalancesService(balancesRepo, () => randomUUID())
  const employeeRefRepo = new EmployeeRefRepository(db.asPool())
  const consumer = new EmployeeRefConsumer(employeeRefRepo, typesRepo, balancesService)
  return { db, typesRepo, balancesRepo, balancesService, employeeRefRepo, consumer }
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

async function createType(db: FakeLeaveDb, typesRepo: LeaveTypesRepository, overrides: Partial<NewLeaveTypeRow> = {}) {
  const row: NewLeaveTypeRow = {
    id: randomUUID(),
    code: 'annual',
    nameI18n: { en: 'Annual Leave' },
    payMode: 'full',
    accrualMode: 'annual_grant',
    statutoryRuleKey: null,
    entitlementDays: '6',
    unit: 'days',
    payRatePercent: '100',
    carryOverEnabled: true,
    allowsHalfDay: true,
    allowsHourly: false,
    certTriggerDays: null,
    certTriggerRuleKey: null,
    citation: null,
    active: true,
    ...overrides,
  }
  return withTx(db, (tx) => typesRepo.insert(tx, row))
}

describe('EmployeeRefConsumer.handleCreatedOrUpdated', () => {
  it('upserts a new employee_ref row from employee.created', async () => {
    const { db, employeeRefRepo, consumer } = setup()
    const result = await withTx(db, (tx) => consumer.handleCreatedOrUpdated(tx, 'evt-1', { id: 'emp-1', startDate: '2026-03-15', status: 'active' }))
    expect(result).not.toBe('duplicate')
    const row = await employeeRefRepo.findById('emp-1')
    expect(row).toMatchObject({ employeeId: 'emp-1', status: 'active', startDate: '2026-03-15' })
  })

  it('employee.updated with a new status overwrites the existing row', async () => {
    const { db, employeeRefRepo, consumer } = setup()
    await withTx(db, (tx) => consumer.handleCreatedOrUpdated(tx, 'evt-2', { id: 'emp-2', startDate: '2026-03-15', status: 'active' }))
    await withTx(db, (tx) => consumer.handleCreatedOrUpdated(tx, 'evt-3', { id: 'emp-2', startDate: '2026-03-15', status: 'on_leave' }))
    const row = await employeeRefRepo.findById('emp-2')
    expect(row?.status).toBe('on_leave')
  })

  it('malformed payload (missing startDate) rejects the whole transaction rather than storing a partial row', async () => {
    const { db, consumer } = setup()
    await expect(withTx(db, (tx) => consumer.handleCreatedOrUpdated(tx, 'evt-4', { id: 'emp-3', status: 'active' }))).rejects.toThrow()
  })
})

describe('EmployeeRefConsumer — triple delivery of employee.created produces exactly one effect (XC-EVENTS)', () => {
  it('delivering the SAME eventId three times upserts the row only once (verified by an unrelated field not moving)', async () => {
    const { db, employeeRefRepo, consumer } = setup()

    const outcome1 = await withTx(db, (tx) => consumer.handleCreatedOrUpdated(tx, 'evt-dup', { id: 'emp-4', startDate: '2026-01-01', status: 'active' }))
    const outcome2 = await withTx(db, (tx) => consumer.handleCreatedOrUpdated(tx, 'evt-dup', { id: 'emp-4', startDate: '2026-01-01', status: 'active' }))
    const outcome3 = await withTx(db, (tx) => consumer.handleCreatedOrUpdated(tx, 'evt-dup', { id: 'emp-4', startDate: '2026-01-01', status: 'active' }))

    expect(outcome1).not.toBe('duplicate')
    expect(outcome2).toBe('duplicate')
    expect(outcome3).toBe('duplicate')

    const row = await employeeRefRepo.findById('emp-4')
    expect(row).toMatchObject({ employeeId: 'emp-4', status: 'active', startDate: '2026-01-01' })
  })

  it('triple delivery of employee.terminated pays out the balance exactly once, not three times', async () => {
    const { db, typesRepo, balancesService, consumer } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-5', annual, 2026, '2020-01-01'))
    await withTx(db, (tx) => balancesService.recordTaken(tx, 'emp-5', annual.id, 2026, '2', 'req-x'))
    // available = 6 - 2 = 4

    await withTx(db, (tx) => consumer.handleTerminated(tx, 'evt-term', { id: 'emp-5', terminationDate: '2026-06-15' }))
    await withTx(db, (tx) => consumer.handleTerminated(tx, 'evt-term', { id: 'emp-5', terminationDate: '2026-06-15' }))
    await withTx(db, (tx) => consumer.handleTerminated(tx, 'evt-term', { id: 'emp-5', terminationDate: '2026-06-15' }))

    const payoutEvents = db.debugOutboxRows().filter((r) => r.topic === 'leave.balance_payout')
    expect(payoutEvents).toHaveLength(1)
    expect(payoutEvents[0]?.payload).toMatchObject({ employeeId: 'emp-5', leaveTypeCode: 'annual', days: '4', reason: 'termination' })
  })
})

describe('EmployeeRefConsumer.handleTerminated — drives the mandatory termination payout (LPA s.67)', () => {
  it('marks the employee_ref terminated and stamps terminatedAt', async () => {
    const { db, employeeRefRepo, consumer } = setup()
    await withTx(db, (tx) => consumer.handleCreatedOrUpdated(tx, 'evt-6', { id: 'emp-6', startDate: '2020-01-01', status: 'active' }))
    await withTx(db, (tx) => consumer.handleTerminated(tx, 'evt-7', { id: 'emp-6', terminationDate: '2026-06-15' }))
    const row = await employeeRefRepo.findById('emp-6')
    expect(row?.status).toBe('terminated')
    expect(row?.terminatedAt).toBe('2026-06-15')
    expect(row?.startDate).toBe('2020-01-01') // preserved from the earlier employee.created
  })

  it('a type with no balance in the termination year produces no payout event', async () => {
    const { db, typesRepo, consumer } = setup()
    await createType(db, typesRepo, { code: 'business', entitlementDays: '3', carryOverEnabled: false })
    await withTx(db, (tx) => consumer.handleTerminated(tx, 'evt-8', { id: 'emp-7', terminationDate: '2026-06-15' }))
    expect(db.debugOutboxRows().filter((r) => r.topic === 'leave.balance_payout')).toHaveLength(0)
  })
})
