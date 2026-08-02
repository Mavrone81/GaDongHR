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

  it('rejects a .sensitive.read action whose purpose is only zero-width characters (fix round 1, IMPORTANT 6: same definition of "blank" as crypto/client.ts isBlankPurpose)', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()
    // ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D), BOM (U+FEFF) — survive
    // .trim() (they are not whitespace) but render blank. Built via
    // fromCharCode rather than a literal in the source so the exact code
    // points are unambiguous.
    const zeroWidthOnlyPurpose = String.fromCharCode(0x200b, 0x200c, 0x200d, 0xfeff)

    await expect(
      emitter.emit(tx, 'onboarding', {
        ...baseEntry,
        action: 'employee.sensitive.read',
        purpose: zeroWidthOnlyPurpose,
      }),
    ).rejects.toThrow(/purpose/i)

    expect(db.debugOutboxRows()).toHaveLength(0)
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
