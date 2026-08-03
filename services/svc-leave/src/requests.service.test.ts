import { randomUUID } from 'node:crypto'
import { CryptoClient } from '@gadong/kernel'
import { BalancesRepository } from './balances.repository'
import { BalancesService } from './balances.service'
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
  const service = new RequestsService(requestsRepo, typesRepo, balancesService, crypto, config, () => randomUUID())
  return { db, typesRepo, balancesRepo, balancesService, requestsRepo, config, crypto, service }
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
    allowsHourly: true,
    certTriggerDays: null,
    certTriggerRuleKey: null,
    citation: null,
    active: true,
    ...overrides,
  }
  return withTx(db, (tx) => typesRepo.insert(tx, row))
}

describe('RequestsService.submit — attachment_ref is ciphertext, never the plaintext pointer', () => {
  it('a request with an attachment stores attachment_ref as bytes that do not contain the plaintext pointer', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const sick = await createType(db, typesRepo, {
      code: 'sick',
      entitlementDays: '30',
      certTriggerDays: '3',
      certTriggerRuleKey: 'leave.sick.cert_trigger_days',
    })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-1', sick, 2026, '2020-01-01'))

    const plaintextPointer = 'minio://certs/emp-1/2026-06-01-medcert.pdf'
    const created = await withTx(db, (tx) =>
      service.submit(tx, {
        employeeId: 'emp-1',
        leaveTypeId: sick.id,
        startDate: '2026-06-01',
        endDate: '2026-06-03',
        attachmentPointer: plaintextPointer,
      }),
    )

    expect(created.attachmentRef).toBeInstanceOf(Buffer)
    expect(created.attachmentRef).not.toBeNull()
    // The whole point: the RAW column value never contains the plaintext pointer as a substring.
    expect(created.attachmentRef?.toString('latin1')).not.toContain(plaintextPointer)
    expect(created.attachmentRef?.toString('utf8')).not.toContain(plaintextPointer)
  })

  it('decrypts back to the original plaintext pointer via CryptoClient.decrypt', async () => {
    const { db, typesRepo, balancesService, service, crypto } = setup()
    const sick = await createType(db, typesRepo, { code: 'sick', entitlementDays: '30', certTriggerDays: '3', certTriggerRuleKey: 'leave.sick.cert_trigger_days' })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-2', sick, 2026, '2020-01-01'))
    const plaintextPointer = 'minio://certs/emp-2/cert.pdf'
    const created = await withTx(db, (tx) =>
      service.submit(tx, { employeeId: 'emp-2', leaveTypeId: sick.id, startDate: '2026-06-01', endDate: '2026-06-03', attachmentPointer: plaintextPointer }),
    )
    const decrypted = await crypto.decrypt(created.id, 'attachment_ref', created.attachmentRef as Buffer, 'test.read')
    expect(decrypted).toBe(plaintextPointer)
  })

  it('a request with no attachment stores attachment_ref as null', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-3', annual, 2026, '2020-01-01'))
    const created = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-3', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01' }))
    expect(created.attachmentRef).toBeNull()
  })
})

describe('RequestsService.submit — medical certificate trigger (>=3 consecutive days)', () => {
  it('a 2-day sick request does NOT require a certificate — the floor forbids demanding one below 3', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const sick = await createType(db, typesRepo, { code: 'sick', entitlementDays: '30', certTriggerDays: '3', certTriggerRuleKey: 'leave.sick.cert_trigger_days' })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-4', sick, 2026, '2020-01-01'))

    const created = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-4', leaveTypeId: sick.id, startDate: '2026-06-01', endDate: '2026-06-02' }))
    expect(created.certRequired).toBe(false)
    expect(created.status).toBe('pending')
  })

  it('a 3-day sick request WITHOUT an attachment is rejected with LVE-011', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const sick = await createType(db, typesRepo, { code: 'sick', entitlementDays: '30', certTriggerDays: '3', certTriggerRuleKey: 'leave.sick.cert_trigger_days' })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-5', sick, 2026, '2020-01-01'))

    await expect(
      withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-5', leaveTypeId: sick.id, startDate: '2026-06-01', endDate: '2026-06-03' })),
    ).rejects.toMatchObject({ code: 'LVE-011' })
  })

  it('a 3-day sick request WITH an attachment succeeds and cert_required is true', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const sick = await createType(db, typesRepo, { code: 'sick', entitlementDays: '30', certTriggerDays: '3', certTriggerRuleKey: 'leave.sick.cert_trigger_days' })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-6', sick, 2026, '2020-01-01'))

    const created = await withTx(db, (tx) =>
      service.submit(tx, { employeeId: 'emp-6', leaveTypeId: sick.id, startDate: '2026-06-01', endDate: '2026-06-03', attachmentPointer: 'minio://certs/x.pdf' }),
    )
    expect(created.certRequired).toBe(true)
  })
})

describe('RequestsService.submit — half-day and hourly arithmetic', () => {
  it('a half-day request is exactly 0.5 days', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-7', annual, 2026, '2020-01-01'))
    const created = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-7', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01', halfDayPeriod: 'AM' }))
    expect(created.days).toBe('0.5')
  })

  it('half-day is rejected when the leave type does not allow it', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo, { allowsHalfDay: false })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-8', annual, 2026, '2020-01-01'))
    await expect(
      withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-8', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01', halfDayPeriod: 'AM' })),
    ).rejects.toMatchObject({ code: 'LVE-050' })
  })

  it('an hourly request (4 hours against an 8-hour statutory day, from config) is exactly 0.5 days', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-9', annual, 2026, '2020-01-01'))
    const created = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-9', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01', hours: '4' }))
    expect(created.days).toBe('0.5')
  })

  it('changing the config workday-hours figure moves the hourly-to-day conversion (config-driven, not a constant)', async () => {
    const { db, typesRepo, balancesService, service, config } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-10', annual, 2026, '2020-01-01'))
    const eightHourDay = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-10', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01', hours: '4' }))
    expect(eightHourDay.days).toBe('0.5')

    config.amend('hours.regular.max_per_day', { value: 4, statutoryFloor: 4 })
    const fourHourDay = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-10', leaveTypeId: annual.id, startDate: '2026-06-02', endDate: '2026-06-02', hours: '4' }))
    expect(fourHourDay.days).toBe('1')
  })

  it('hourly is rejected when the leave type does not allow it', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo, { allowsHourly: false })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-11', annual, 2026, '2020-01-01'))
    await expect(
      withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-11', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01', hours: '4' })),
    ).rejects.toMatchObject({ code: 'LVE-051' })
  })
})

describe('RequestsService.submit — insufficient balance and overlapping dates', () => {
  it('requesting more days than available is rejected with LVE-010', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo, { entitlementDays: '2' })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-12', annual, 2026, '2020-01-01'))
    await expect(
      withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-12', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-05' })),
    ).rejects.toMatchObject({ code: 'LVE-010' })
  })

  it('unpaid leave types are never blocked by balance', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const unpaid = await createType(db, typesRepo, { code: 'ordination', payMode: 'unpaid', entitlementDays: null })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-13', unpaid, 2026, '2020-01-01'))
    const created = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-13', leaveTypeId: unpaid.id, startDate: '2026-06-01', endDate: '2026-06-10' }))
    expect(created.days).toBe('10')
  })

  it('a second request overlapping an existing pending request is rejected with LVE-020', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo, { entitlementDays: '20' })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-14', annual, 2026, '2020-01-01'))
    await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-14', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-05' }))
    await expect(
      withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-14', leaveTypeId: annual.id, startDate: '2026-06-04', endDate: '2026-06-06' })),
    ).rejects.toMatchObject({ code: 'LVE-020' })
  })

  it('a non-overlapping request succeeds', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo, { entitlementDays: '20' })
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-15', annual, 2026, '2020-01-01'))
    await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-15', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-05' }))
    const second = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-15', leaveTypeId: annual.id, startDate: '2026-06-06', endDate: '2026-06-07' }))
    expect(second.status).toBe('pending')
  })
})

describe('RequestsService.cancel', () => {
  it('cancelling a pending request succeeds and does not emit leave.cancelled (nothing downstream consumed it yet)', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-16', annual, 2026, '2020-01-01'))
    const created = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-16', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01' }))
    const cancelled = await withTx(db, (tx) => service.cancel(tx, created.id, 'emp-16', '2026-05-01'))
    expect(cancelled.status).toBe('cancelled')
    expect(db.debugOutboxRows().filter((r) => r.topic === 'leave.cancelled')).toHaveLength(0)
  })

  it('a non-owner cannot cancel another employee\'s request', async () => {
    const { db, typesRepo, balancesService, service } = setup()
    const annual = await createType(db, typesRepo)
    await withTx(db, (tx) => balancesService.grantAnnual(tx, 'emp-17', annual, 2026, '2020-01-01'))
    const created = await withTx(db, (tx) => service.submit(tx, { employeeId: 'emp-17', leaveTypeId: annual.id, startDate: '2026-06-01', endDate: '2026-06-01' }))
    await expect(withTx(db, (tx) => service.cancel(tx, created.id, 'someone-else', '2026-05-01'))).rejects.toMatchObject({ code: 'LVE-403' })
  })
})
