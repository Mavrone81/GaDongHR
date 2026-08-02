import { AuditEmitter } from './emitter'
import type { AuditEntry } from './emitter'
import { hashValue } from './canonical-json'
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

  // --- Task 9b: "Audit payloads must carry hashes, not values" ---

  it('never lets a raw sensitive value reach the outbox payload, in any form, anywhere in the serialised JSON', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()

    await tx.query('BEGIN')
    await emitter.emit(tx, 'onboarding', {
      ...baseEntry,
      before: { salary: 45000, nationalId: '1101700207364' },
      after: { salary: 47000, nationalId: '1101700207364' },
    })
    await tx.query('COMMIT')

    const row = db.debugOutboxRows()[0]
    if (row === undefined) throw new Error('unreachable: row was just inserted')

    // Search the WHOLE serialised payload, not just top-level keys — a
    // value nested, stringified, or renamed would still be a leak.
    const serialised = JSON.stringify(row.payload)
    expect(serialised).not.toContain('45000')
    expect(serialised).not.toContain('47000')
    expect(serialised).not.toContain('1101700207364')

    // And the payload has no `before`/`after` keys at all — hashes only.
    expect(row.payload).not.toHaveProperty('before')
    expect(row.payload).not.toHaveProperty('after')
    expect(row.payload).toMatchObject({
      beforeHash: hashValue({ salary: 45000, nationalId: '1101700207364' }),
      afterHash: hashValue({ salary: 47000, nationalId: '1101700207364' }),
    })
  })

  it('hashes the same input identically across two separate emit calls, and identically to the shared canonicaliser', async () => {
    const db = new FakeDb()
    const emitter = new AuditEmitter()
    const before = { salary: 45000, nationalId: '1101700207364' }

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await emitter.emit(tx1, 'onboarding', { ...baseEntry, entityId: 'emp-1', before, after: undefined })
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await emitter.emit(tx2, 'onboarding', { ...baseEntry, entityId: 'emp-2', before, after: undefined })
    await tx2.query('COMMIT')

    const rows = db.debugOutboxRows()
    const hash1 = (rows[0]?.payload as { beforeHash: string }).beforeHash
    const hash2 = (rows[1]?.payload as { beforeHash: string }).beforeHash

    expect(hash1).toBe(hash2)
    // "identically to svc-audit's canonicaliser": `hashValue` here IS
    // svc-audit's canonicaliser — `services/svc-audit/src/chain.ts` imports
    // `canonicalJson`/`hashValue`/`sha256Hex` from this same kernel module
    // (`./canonical-json`) rather than keeping its own copy, specifically so
    // the two sides cannot silently diverge. See canonical-json.ts's doc
    // comment and chain.ts's re-export for the full rationale.
    expect(hash1).toBe(hashValue(before))
  })

  it('key insertion order does not change the hash', async () => {
    const db = new FakeDb()
    const emitter = new AuditEmitter()

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await emitter.emit(tx1, 'onboarding', {
      ...baseEntry,
      entityId: 'emp-1',
      before: { salary: 45000, nationalId: '1101700207364' },
      after: undefined,
    })
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await emitter.emit(tx2, 'onboarding', {
      ...baseEntry,
      entityId: 'emp-2',
      before: { nationalId: '1101700207364', salary: 45000 },
      after: undefined,
    })
    await tx2.query('COMMIT')

    const rows = db.debugOutboxRows()
    const hash1 = (rows[0]?.payload as { beforeHash: string }).beforeHash
    const hash2 = (rows[1]?.payload as { beforeHash: string }).beforeHash
    expect(hash1).toBe(hash2)
  })

  it('a missing (undefined) before/after produces a null hash field, not a hash of "null"', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()

    await tx.query('BEGIN')
    await emitter.emit(tx, 'onboarding', { ...baseEntry, before: undefined, after: undefined })
    await tx.query('COMMIT')

    const row = db.debugOutboxRows()[0]
    expect(row?.payload).toMatchObject({ beforeHash: null, afterHash: null })
    expect((row?.payload as { beforeHash: unknown }).beforeHash).not.toBe(hashValue(null))
  })

  it('an explicit null before/after also produces a null hash field, not a hash of "null"', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const emitter = new AuditEmitter()

    await tx.query('BEGIN')
    await emitter.emit(tx, 'onboarding', { ...baseEntry, before: null, after: null })
    await tx.query('COMMIT')

    const row = db.debugOutboxRows()[0]
    expect(row?.payload).toMatchObject({ beforeHash: null, afterHash: null })
    expect((row?.payload as { afterHash: unknown }).afterHash).not.toBe(hashValue(null))
  })

  it('a create (no before) and a delete (no after) each hash only the side that exists', async () => {
    const db = new FakeDb()
    const emitter = new AuditEmitter()

    const created = db.connect()
    await created.query('BEGIN')
    await emitter.emit(created, 'onboarding', { ...baseEntry, entityId: 'emp-1', before: undefined, after: { status: 'active' } })
    await created.query('COMMIT')

    const deleted = db.connect()
    await deleted.query('BEGIN')
    await emitter.emit(deleted, 'onboarding', { ...baseEntry, entityId: 'emp-2', before: { status: 'active' }, after: undefined })
    await deleted.query('COMMIT')

    const rows = db.debugOutboxRows()
    expect(rows[0]?.payload).toMatchObject({ beforeHash: null, afterHash: hashValue({ status: 'active' }) })
    expect(rows[1]?.payload).toMatchObject({ beforeHash: hashValue({ status: 'active' }), afterHash: null })
  })
})
