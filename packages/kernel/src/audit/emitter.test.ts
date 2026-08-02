import { AuditEmitter } from './emitter'
import type { AuditEntry } from './emitter'
import { FakeDb } from '../outbox/testing/fake-db'

const baseEntry: AuditEntry = {
  actorId: 'user-1',
  actorRole: 'hr-officer',
  action: 'employee.update',
  entity: 'employee',
  entityId: 'emp-1',
  before: { status: 'active' },
  after: { status: 'terminated' },
}

describe('AuditEmitter', () => {
  it('writes the entry to the outbox as audit.<action> through the caller transaction', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()

    await tx.query('BEGIN')
    await emitter.emit(tx, 'onboarding', baseEntry)
    await tx.query('COMMIT')

    const rows = db.debugOutboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.topic).toBe('audit.employee.update')
    expect(rows[0]?.payload).toMatchObject({
      actorId: 'user-1',
      actorRole: 'hr-officer',
      action: 'employee.update',
      entity: 'employee',
      entityId: 'emp-1',
    })
  })

  it('does not survive a rolled-back write', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()

    await tx.query('BEGIN')
    await emitter.emit(tx, 'onboarding', baseEntry)
    await tx.query('ROLLBACK')

    expect(db.debugOutboxRows()).toHaveLength(0)
  })

  it('is not lost when the caller write commits', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()

    await tx.query('BEGIN')
    await emitter.emit(tx, 'onboarding', baseEntry)
    await tx.query('COMMIT')

    expect(db.debugOutboxRows()).toHaveLength(1)
  })

  it('rejects a .sensitive.read action with no purpose', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()

    await expect(
      emitter.emit(tx, 'onboarding', { ...baseEntry, action: 'employee.sensitive.read' }),
    ).rejects.toThrow(/purpose/i)

    expect(db.debugOutboxRows()).toHaveLength(0)
  })

  it('rejects a .sensitive.read action with a whitespace-only purpose', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()

    await expect(
      emitter.emit(tx, 'onboarding', { ...baseEntry, action: 'employee.sensitive.read', purpose: '   ' }),
    ).rejects.toThrow(/purpose/i)
  })

  it('accepts a .sensitive.read action that carries a purpose', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()

    await tx.query('BEGIN')
    await emitter.emit(tx, 'onboarding', {
      ...baseEntry,
      action: 'employee.sensitive.read',
      purpose: 'payroll export',
    })
    await tx.query('COMMIT')

    const rows = db.debugOutboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.topic).toBe('audit.employee.sensitive.read')
  })
})
