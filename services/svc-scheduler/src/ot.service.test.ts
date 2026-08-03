import { ConfigClient } from './config-client'
import type { ConfigTransport } from './config-client'
import { OtRepository } from './ot.repository'
import { OtService } from './ot.service'
import { FakeSchedulerDb } from './testing/fake-db'

function configTransport(otCeilingHours: number): ConfigTransport {
  return {
    get: (path: string) => {
      if (path.startsWith('/rules/hours.ot.max_per_week')) {
        return Promise.resolve({
          ruleKey: 'hours.ot.max_per_week',
          value: otCeilingHours,
          unit: 'hours',
          citation: 'LPA s.26 + Ministerial Reg.',
          statutoryFloor: null,
          statutoryCeiling: otCeilingHours,
        })
      }
      return Promise.reject(new Error(`unexpected rule: ${path}`))
    },
  }
}

describe('OtService.request', () => {
  it('requires employee consent (LPA s.24) — SCH-021 without it', async () => {
    const db = new FakeSchedulerDb()
    const service = new OtService(new OtRepository(db.asPool()), new ConfigClient(configTransport(36)))
    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(
      service.request(tx, { employeeId: 'emp-1', date: '2026-08-05', hours: 3, rateClass: 'workday', reason: 'rush order', employeeConsent: false }),
    ).rejects.toMatchObject({ code: 'SCH-021' })
  })

  it('records the request with its rate class as a decimal-string hours value', async () => {
    const db = new FakeSchedulerDb()
    const service = new OtService(new OtRepository(db.asPool()), new ConfigClient(configTransport(36)))
    const tx = db.connect()
    await tx.query('BEGIN')
    const result = await service.request(tx, {
      employeeId: 'emp-1',
      date: '2026-08-05',
      hours: 2.5,
      rateClass: 'holiday_ot',
      reason: 'production deadline',
      employeeConsent: true,
    })
    await tx.query('COMMIT')

    expect(result.request.status).toBe('pending')
    expect(result.request.rateClass).toBe('holiday_ot')
    expect(result.request.hours).toBe('2.50')
    expect(result.weeklyOtTotal.ceilingHours).toBe('36.00')
  })
})

describe('OtService.decide — approval re-checks the 36h/week ceiling, and preserves rate class through the event payload', () => {
  it('approves a request comfortably under the weekly ceiling and publishes ot.approved with the rate class intact', async () => {
    const db = new FakeSchedulerDb()
    const service = new OtService(new OtRepository(db.asPool()), new ConfigClient(configTransport(36)))
    const tx = db.connect()
    await tx.query('BEGIN')
    const { request } = await service.request(tx, {
      employeeId: 'emp-1',
      date: '2026-08-05',
      hours: 4,
      rateClass: 'holiday_work',
      reason: 'urgent order',
      employeeConsent: true,
    })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const approved = await service.decide(tx2, request.id, 'approve', 'mgr-1', null)
    await tx2.query('COMMIT')

    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBe('mgr-1')

    const outboxRows = db.debugOutboxRows()
    expect(outboxRows).toHaveLength(1)
    expect(outboxRows[0]?.topic).toBe('ot.approved')
    // THE preservation proof: what payroll reads off the event is exactly
    // what was requested — the rate class was never renamed/recomputed
    // between request and the outbox write.
    expect(outboxRows[0]?.payload).toMatchObject({
      employeeId: 'emp-1',
      otDate: '2026-08-05',
      hours: '4.00',
      rateClass: 'holiday_work',
      approvedBy: 'mgr-1',
    })
  })

  it('blocks approval once the week\'s already-approved OT plus this request would exceed the 36h ceiling (SCH-020)', async () => {
    const db = new FakeSchedulerDb()
    const service = new OtService(new OtRepository(db.asPool()), new ConfigClient(configTransport(36)))

    // First request: 34h, approved.
    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const first = await service.request(tx1, { employeeId: 'emp-1', date: '2026-08-04', hours: 34, rateClass: 'workday', reason: 'x', employeeConsent: true })
    await tx1.query('COMMIT')
    const tx1b = db.connect()
    await tx1b.query('BEGIN')
    await service.decide(tx1b, first.request.id, 'approve', 'mgr-1', null)
    await tx1b.query('COMMIT')

    // Second request, same ISO week: 3h more -> 37h total, over the 36h ceiling.
    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const second = await service.request(tx2, { employeeId: 'emp-1', date: '2026-08-06', hours: 3, rateClass: 'workday', reason: 'y', employeeConsent: true })
    await tx2.query('COMMIT')

    const tx3 = db.connect()
    await tx3.query('BEGIN')
    await expect(service.decide(tx3, second.request.id, 'approve', 'mgr-1', null)).rejects.toMatchObject({ code: 'SCH-020' })

    // Never approved, and no ot.approved event for the rejected-by-ceiling request.
    const outboxRows = db.debugOutboxRows()
    expect(outboxRows).toHaveLength(1) // only the FIRST request's approval
  })

  it('CONFIG-DRIVEN: the same 37h total that blocked at a 36h ceiling approves cleanly once config raises the ceiling to 40h', async () => {
    const db = new FakeSchedulerDb()
    const service = new OtService(new OtRepository(db.asPool()), new ConfigClient(configTransport(40)))

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const first = await service.request(tx1, { employeeId: 'emp-1', date: '2026-08-04', hours: 34, rateClass: 'workday', reason: 'x', employeeConsent: true })
    await tx1.query('COMMIT')
    const tx1b = db.connect()
    await tx1b.query('BEGIN')
    await service.decide(tx1b, first.request.id, 'approve', 'mgr-1', null)
    await tx1b.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const second = await service.request(tx2, { employeeId: 'emp-1', date: '2026-08-06', hours: 3, rateClass: 'workday', reason: 'y', employeeConsent: true })
    await tx2.query('COMMIT')

    const tx3 = db.connect()
    await tx3.query('BEGIN')
    const approved = await service.decide(tx3, second.request.id, 'approve', 'mgr-1', null)
    await tx3.query('COMMIT')
    expect(approved.status).toBe('approved')
  })

  it('rejecting requires a reason (mirrors the roster override-reason discipline)', async () => {
    const db = new FakeSchedulerDb()
    const service = new OtService(new OtRepository(db.asPool()), new ConfigClient(configTransport(36)))
    const tx = db.connect()
    await tx.query('BEGIN')
    const { request } = await service.request(tx, { employeeId: 'emp-1', date: '2026-08-05', hours: 2, rateClass: 'workday', reason: 'x', employeeConsent: true })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(service.decide(tx2, request.id, 'reject', 'mgr-1', null)).rejects.toMatchObject({ code: 'SCH-022' })

    const rejected = await service.decide(tx2, request.id, 'reject', 'mgr-1', 'headcount already sufficient')
    expect(rejected.status).toBe('rejected')
    expect(rejected.decisionReason).toBe('headcount already sufficient')
  })
})
