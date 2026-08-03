import { EmployeeRefRepository } from './employee-ref.repository'
import { EmployeeEventsService } from './employee-events.service'
import { FakeClaimsDb } from './testing/fake-db'

function makeService(): { service: EmployeeEventsService; db: FakeClaimsDb } {
  const db = new FakeClaimsDb()
  const service = new EmployeeEventsService(new EmployeeRefRepository(db.asPool()))
  return { service, db }
}

/**
 * Task 14 brief TESTS: "Triple delivery of `employee.created` produces one
 * effect." Consumes via the kernel's `idempotent()`, which dedupes on
 * `claims.processed_events(event_id)` in the SAME transaction as the
 * `claims_employee_ref` upsert (XC-EVENTS).
 */
describe('EmployeeEventsService — consumes employee.* into claims_employee_ref, idempotently', () => {
  it('employee.created upserts a claims_employee_ref row', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.handle(conn, { topic: 'employee.created', eventId: 'evt-1', payload: { id: 'emp-1', status: 'active' } })
    await conn.query('COMMIT')

    expect(result).not.toBe('duplicate')
    expect(db.debugEmployeeRefs()).toEqual([{ employee_id: 'emp-1', status: 'active', updated_at: expect.any(Date) }])
  })

  it('employee.terminated sets status to terminated', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.handle(conn, { topic: 'employee.created', eventId: 'evt-1', payload: { id: 'emp-1', status: 'active' } })
    await service.handle(conn, { topic: 'employee.terminated', eventId: 'evt-2', payload: { id: 'emp-1' } })
    await conn.query('COMMIT')

    expect(db.debugEmployeeRefs()).toEqual([{ employee_id: 'emp-1', status: 'terminated', updated_at: expect.any(Date) }])
  })

  it('THE test: triple delivery of the SAME eventId produces exactly one effect', async () => {
    const { service, db } = makeService()
    const event = { topic: 'employee.created' as const, eventId: 'evt-triple', payload: { id: 'emp-9', status: 'active' } }

    for (let i = 0; i < 3; i++) {
      const conn = db.connect()
      await conn.query('BEGIN')
      await service.handle(conn, event)
      await conn.query('COMMIT')
    }

    expect(db.debugEmployeeRefs()).toHaveLength(1)
  })

  it('the second and third deliveries report "duplicate" rather than re-running the handler', async () => {
    const { service, db } = makeService()
    const event = { topic: 'employee.created' as const, eventId: 'evt-dup', payload: { id: 'emp-1', status: 'active' } }

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const first = await service.handle(conn1, event)
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    const second = await service.handle(conn2, event)
    await conn2.query('COMMIT')

    expect(first).not.toBe('duplicate')
    expect(second).toBe('duplicate')
  })

  it('a rolled-back delivery is NOT marked processed — redelivery of the same eventId still runs the handler', async () => {
    const { service, db } = makeService()
    const event = { topic: 'employee.created' as const, eventId: 'evt-rollback', payload: { id: 'emp-1', status: 'active' } }

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    await service.handle(conn1, event)
    await conn1.query('ROLLBACK')

    expect(db.debugEmployeeRefs()).toHaveLength(0)

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    const second = await service.handle(conn2, event)
    await conn2.query('COMMIT')

    expect(second).not.toBe('duplicate')
    expect(db.debugEmployeeRefs()).toHaveLength(1)
  })

  it('different eventIds for the same employee both apply (not deduped by employeeId)', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.handle(conn, { topic: 'employee.created', eventId: 'evt-a', payload: { id: 'emp-1', status: 'active' } })
    await service.handle(conn, { topic: 'employee.updated', eventId: 'evt-b', payload: { id: 'emp-1', status: 'on_leave' } })
    await conn.query('COMMIT')

    expect(db.debugEmployeeRefs()).toEqual([{ employee_id: 'emp-1', status: 'on_leave', updated_at: expect.any(Date) }])
  })
})
