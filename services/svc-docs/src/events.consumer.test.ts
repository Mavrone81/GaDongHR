import { EventsConsumer } from './events.consumer'
import { EmployeeRefRepository } from './employee-ref.repository'
import { PayslipRefRepository } from './payslip-ref.repository'
import { FakeDocsDb } from './testing/fake-db'

function makeConsumer(db: FakeDocsDb): EventsConsumer {
  return new EventsConsumer(new EmployeeRefRepository(db.asPool()), new PayslipRefRepository(db.asPool()))
}

describe('EventsConsumer.handleEmployeeUpsert', () => {
  it('upserts docs.employee_ref from an employee.created payload', async () => {
    const db = new FakeDocsDb()
    const consumer = makeConsumer(db)
    const conn = db.connect()
    await conn.query('BEGIN')
    await consumer.handleEmployeeUpsert(conn, 'evt-1', { id: 'emp-1', orgUnitId: 'org-a' })
    await conn.query('COMMIT')

    expect(db.debugEmployeeRefs()).toEqual([expect.objectContaining({ employee_id: 'emp-1', org_unit_id: 'org-a' })])
  })

  it('triple delivery of the same eventId produces exactly one effect (XC-EVENTS)', async () => {
    const db = new FakeDocsDb()
    const consumer = makeConsumer(db)

    for (let i = 0; i < 3; i++) {
      const conn = db.connect()
      await conn.query('BEGIN')
      await consumer.handleEmployeeUpsert(conn, 'evt-dup', { id: 'emp-1', orgUnitId: 'org-a' })
      await conn.query('COMMIT')
    }

    expect(db.debugEmployeeRefs()).toHaveLength(1)
  })

  it('throws on a malformed payload (missing orgUnitId) rather than upserting a broken row', async () => {
    const db = new FakeDocsDb()
    const consumer = makeConsumer(db)
    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(consumer.handleEmployeeUpsert(conn, 'evt-bad', { id: 'emp-1' })).rejects.toThrow(/orgUnitId/)
  })
})

describe('EventsConsumer.handlePayslipIssued', () => {
  it('upserts docs.payslip_ref from a payslip.issued payload', async () => {
    const db = new FakeDocsDb()
    const consumer = makeConsumer(db)
    const conn = db.connect()
    await conn.query('BEGIN')
    await consumer.handlePayslipIssued(conn, 'evt-2', { payslipId: 'payslip-1', employeeId: 'emp-1', runId: 'run-1', lang: 'th' })
    await conn.query('COMMIT')

    expect(db.debugPayslipRefs()).toEqual([expect.objectContaining({ payslip_id: 'payslip-1', employee_id: 'emp-1' })])
  })

  it('triple delivery of the same eventId produces exactly one effect (XC-EVENTS)', async () => {
    const db = new FakeDocsDb()
    const consumer = makeConsumer(db)

    for (let i = 0; i < 3; i++) {
      const conn = db.connect()
      await conn.query('BEGIN')
      await consumer.handlePayslipIssued(conn, 'evt-dup-2', { payslipId: 'payslip-1', employeeId: 'emp-1' })
      await conn.query('COMMIT')
    }

    expect(db.debugPayslipRefs()).toHaveLength(1)
  })
})
