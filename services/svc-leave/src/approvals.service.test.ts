import { randomUUID } from 'node:crypto'
import { CryptoClient } from '@gadong/kernel'
import { ApprovalsRepository } from './approvals.repository'
import { ApprovalsService } from './approvals.service'
import { BalancesRepository } from './balances.repository'
import { BalancesService, available } from './balances.service'
import { LeaveTypesRepository } from './leave-types.repository'
import type { NewLeaveTypeRow } from './leave-types.repository'
import { RequestsRepository } from './requests.repository'
import { RequestsService } from './requests.service'
import { FakeLeaveDb } from './testing/fake-db'
import { FakeConfigClient } from './testing/fake-config-client'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'

function setup() {
  const db = new FakeLeaveDb()
  const typesRepo = new LeaveTypesRepository(db.asPool())
  const balancesRepo = new BalancesRepository(db.asPool())
  const balancesService = new BalancesService(balancesRepo, () => randomUUID())
  const requestsRepo = new RequestsRepository(db.asPool())
  const config = new FakeConfigClient()
  config.seed({ ruleKey: 'hours.regular.max_per_day', value: 8, statutoryFloor: 8, citation: 'LPA s.23', effectiveFrom: '1998-08-19', effectiveTo: null })
  const crypto = new CryptoClient(fakeCryptoTransport())
  const requestsService = new RequestsService(requestsRepo, typesRepo, balancesService, crypto, config, () => randomUUID())
  const approvalsRepo = new ApprovalsRepository(db.asPool())
  const approvalsService = new ApprovalsService(approvalsRepo, requestsRepo, typesRepo, balancesService, () => randomUUID())
  return { db, typesRepo, balancesRepo, balancesService, requestsRepo, requestsService, approvalsRepo, approvalsService }
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
    entitlementDays: '20',
    unit: 'days',
    payRatePercent: '100',
    carryOverEnabled: true,
    allowsHalfDay: true,
    allowsHourly: true,
    certTriggerDays: null,
    certTriggerRuleKey: null,
    citation: null,
    active: true,
    ...overrides,
  }
  return withTx(db, (tx) => typesRepo.insert(tx, row))
}

describe('ApprovalsService — single default level, no configured approval_level rows', () => {
  it('approving the one auto-created level 1 step finalizes the request, decrements the balance, and publishes leave.approved', async () => {
    const { db, typesRepo, balancesService, requestsService, approvalsService } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-1', annual, 2026, '2020-01-01'))
    const request = await withTx(db, (tx) => requestsService.submit(tx, { employeeId: 'emp-1', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-02' }))

    const steps = await withTx(db, (tx) => approvalsService.createChain(tx, request.id, annual.id, request.days))
    expect(steps).toHaveLength(1)
    expect(steps[0]?.level).toBe(1)

    const decided = await withTx(db, (tx) => approvalsService.decide(tx, steps[0]!.id, 'manager-1', 'approved', null, '2026-05-20'))
    expect(decided.decision).toBe('approved')

    const finalRequest = await db.debugTable('leave_request').find((r) => r['id'] === request.id)
    expect(finalRequest?.['status']).toBe('approved')

    const outbox = db.debugOutboxRows().filter((r) => r.topic === 'leave.approved')
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.payload).toMatchObject({ requestId: request.id, employeeId: 'emp-1', leaveTypeCode: 'annual', days: '2', payMode: 'full' })

    const balance = await balancesService.getOrDefault('emp-1', annual.id, 2026)
    expect(balance.taken).toBe('2')
    expect(available(balance)).toBe('18')
  })

  it('rejecting the step marks the request rejected and does NOT decrement the balance or publish leave.approved', async () => {
    const { db, typesRepo, balancesService, requestsService, approvalsService } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-2', annual, 2026, '2020-01-01'))
    const request = await withTx(db, (tx) => requestsService.submit(tx, { employeeId: 'emp-2', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-02' }))
    const steps = await withTx(db, (tx) => approvalsService.createChain(tx, request.id, annual.id, request.days))

    await withTx(db, (tx) => approvalsService.decide(tx, steps[0]!.id, 'manager-1', 'rejected', 'not enough coverage', '2026-05-20'))

    const finalRequest = await db.debugTable('leave_request').find((r) => r['id'] === request.id)
    expect(finalRequest?.['status']).toBe('rejected')
    expect(db.debugOutboxRows().filter((r) => r.topic === 'leave.approved')).toHaveLength(0)

    const balance = await balancesService.getOrDefault('emp-2', annual.id, 2026)
    expect(balance.taken).toBe('0')
  })

  it('deciding an already-decided step is rejected', async () => {
    const { db, typesRepo, balancesService, requestsService, approvalsService } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-3', annual, 2026, '2020-01-01'))
    const request = await withTx(db, (tx) => requestsService.submit(tx, { employeeId: 'emp-3', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01' }))
    const steps = await withTx(db, (tx) => approvalsService.createChain(tx, request.id, annual.id, request.days))
    await withTx(db, (tx) => approvalsService.decide(tx, steps[0]!.id, 'manager-1', 'approved', null, '2026-05-20'))

    await expect(withTx(db, (tx) => approvalsService.decide(tx, steps[0]!.id, 'manager-1', 'approved', null, '2026-05-20'))).rejects.toMatchObject({ code: 'LVE-409' })
  })
})

describe('ApprovalsService — multi-level chains by leave type and duration', () => {
  it('a request meeting a level-2 threshold requires BOTH levels before leave.approved publishes', async () => {
    const { db, typesRepo, balancesService, requestsService, approvalsRepo, approvalsService } = setup()
    const annual = await createType(db, typesRepo, { entitlementDays: '30' })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-4', annual, 2026, '2020-01-01'))
    await withTx(db, (tx) =>
      approvalsRepo.insertLevel(tx, { id: randomUUID(), leaveTypeId: annual.id, level: 1, approverRole: 'manager', minDays: '0' }),
    )
    await withTx(db, (tx) =>
      approvalsRepo.insertLevel(tx, { id: randomUUID(), leaveTypeId: annual.id, level: 2, approverRole: 'hr', minDays: '5' }),
    )

    const request = await withTx(db, (tx) => requestsService.submit(tx, { employeeId: 'emp-4', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-10' }))
    expect(request.days).toBe('10')
    const steps = await withTx(db, (tx) => approvalsService.createChain(tx, request.id, annual.id, request.days))
    expect(steps).toHaveLength(2)

    const level1 = steps.find((s) => s.level === 1)!
    const level2 = steps.find((s) => s.level === 2)!

    await withTx(db, (tx) => approvalsService.decide(tx, level1.id, 'manager-1', 'approved', null, '2026-05-20'))
    let midRequest = await db.debugTable('leave_request').find((r) => r['id'] === request.id)
    expect(midRequest?.['status']).toBe('pending') // level 2 still outstanding
    expect(db.debugOutboxRows().filter((r) => r.topic === 'leave.approved')).toHaveLength(0)

    await withTx(db, (tx) => approvalsService.decide(tx, level2.id, 'hr-1', 'approved', null, '2026-05-20'))
    midRequest = await db.debugTable('leave_request').find((r) => r['id'] === request.id)
    expect(midRequest?.['status']).toBe('approved')
    expect(db.debugOutboxRows().filter((r) => r.topic === 'leave.approved')).toHaveLength(1)
  })

  it('a short request below the level-2 threshold only creates a level-1 step', async () => {
    const { db, typesRepo, balancesService, requestsService, approvalsRepo, approvalsService } = setup()
    const annual = await createType(db, typesRepo, { entitlementDays: '30' })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-5', annual, 2026, '2020-01-01'))
    await withTx(db, (tx) => approvalsRepo.insertLevel(tx, { id: randomUUID(), leaveTypeId: annual.id, level: 1, approverRole: 'manager', minDays: '0' }))
    await withTx(db, (tx) => approvalsRepo.insertLevel(tx, { id: randomUUID(), leaveTypeId: annual.id, level: 2, approverRole: 'hr', minDays: '5' }))

    const request = await withTx(db, (tx) => requestsService.submit(tx, { employeeId: 'emp-5', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-02' }))
    const steps = await withTx(db, (tx) => approvalsService.createChain(tx, request.id, annual.id, request.days))
    expect(steps).toHaveLength(1)
    expect(steps[0]?.level).toBe(1)
  })
})

describe('ApprovalsService — delegation for absent approvers', () => {
  it('a delegate may decide a step assigned to an approver who is on leave (their designated delegate, active date range)', async () => {
    const { db, typesRepo, balancesService, requestsService, approvalsRepo, approvalsService } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-6', annual, 2026, '2020-01-01'))
    const request = await withTx(db, (tx) => requestsService.submit(tx, { employeeId: 'emp-6', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01' }))
    const steps = await withTx(db, (tx) => approvalsService.createChain(tx, request.id, annual.id, request.days, { 1: 'manager-absent' }))

    await withTx(db, (tx) =>
      approvalsRepo.insertDelegation(tx, { id: randomUUID(), approverId: 'manager-absent', delegateId: 'manager-delegate', startsOn: '2026-05-15', endsOn: '2026-05-25' }),
    )

    const decided = await withTx(db, (tx) => approvalsService.decide(tx, steps[0]!.id, 'manager-delegate', 'approved', null, '2026-05-20'))
    expect(decided.decision).toBe('approved')
    expect(decided.decidedBy).toBe('manager-delegate')
    expect(decided.approverId).toBe('manager-absent') // the ASSIGNED approver is unchanged — only decidedBy differs
  })

  it('a caller who is neither the assigned approver nor an active delegate is rejected', async () => {
    const { db, typesRepo, balancesService, requestsService, approvalsService } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-7', annual, 2026, '2020-01-01'))
    const request = await withTx(db, (tx) => requestsService.submit(tx, { employeeId: 'emp-7', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01' }))
    const steps = await withTx(db, (tx) => approvalsService.createChain(tx, request.id, annual.id, request.days, { 1: 'manager-assigned' }))

    await expect(withTx(db, (tx) => approvalsService.decide(tx, steps[0]!.id, 'random-user', 'approved', null, '2026-05-20'))).rejects.toMatchObject({ code: 'LVE-403' })
  })

  it('a delegation OUTSIDE its date range does not authorize the delegate', async () => {
    const { db, typesRepo, balancesService, requestsService, approvalsRepo, approvalsService } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-8', annual, 2026, '2020-01-01'))
    const request = await withTx(db, (tx) => requestsService.submit(tx, { employeeId: 'emp-8', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01' }))
    const steps = await withTx(db, (tx) => approvalsService.createChain(tx, request.id, annual.id, request.days, { 1: 'manager-absent' }))
    await withTx(db, (tx) =>
      approvalsRepo.insertDelegation(tx, { id: randomUUID(), approverId: 'manager-absent', delegateId: 'manager-delegate', startsOn: '2026-01-01', endsOn: '2026-01-31' }),
    )

    await expect(
      withTx(db, (tx) => approvalsService.decide(tx, steps[0]!.id, 'manager-delegate', 'approved', null, '2026-05-20')),
    ).rejects.toMatchObject({ code: 'LVE-403' })
  })
})
