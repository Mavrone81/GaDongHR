import { AuditConsumer, parseAuditPayload } from './consumer'
import type { RawAuditEvent } from './consumer'
import { EntriesRepository } from './entries.repository'
import { FakeAuditDb } from './testing/fake-db'
import { GENESIS_PREV_HASH, computeEntryHash, hashValue } from './chain'

const FIXED_NOW = new Date('2026-08-01T12:00:00.000Z')

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actorId: 'user-1',
    actorRole: 'hr-officer',
    action: 'employee.update',
    entity: 'employee',
    entityId: 'emp-1',
    before: { status: 'active' },
    after: { status: 'terminated' },
    ...overrides,
  }
}

function event(overrides: Partial<RawAuditEvent> = {}): RawAuditEvent {
  return { eventId: 'evt-1', topic: 'audit.employee.update', payload: basePayload(), ...overrides }
}

describe('AuditConsumer.consume', () => {
  it('applies a first delivery and inserts one chained entry', async () => {
    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()

    await tx.query('BEGIN')
    const result = await consumer.consume(tx, event())
    await tx.query('COMMIT')

    expect(result).toBe('applied')
    const rows = db.debugEntries()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.prev_entry_hash).toBe(GENESIS_PREV_HASH)
    expect(rows[0]?.entity).toBe('employee')
    expect(rows[0]?.entity_id).toBe('emp-1')
  })

  it('hashes before/after — the row never carries the raw values', async () => {
    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()

    await tx.query('BEGIN')
    await consumer.consume(tx, event())
    await tx.query('COMMIT')

    const row = db.debugEntries()[0]
    expect(row?.before_hash).toBe(hashValue({ status: 'active' }))
    expect(row?.after_hash).toBe(hashValue({ status: 'terminated' }))
    const serialised = JSON.stringify(row)
    expect(serialised).not.toContain('"active"')
    expect(serialised).not.toContain('"terminated"')
  })

  it('the same event delivered three times produces exactly one entry (XC-EVENTS)', async () => {
    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const results: Array<'applied' | 'duplicate'> = []

    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      results.push(await consumer.consume(tx, event({ eventId: 'evt-dup' })))
      await tx.query('COMMIT')
    }

    expect(results).toEqual(['applied', 'duplicate', 'duplicate'])
    expect(db.debugEntries()).toHaveLength(1)
  })

  it('two distinct events chain: the second entry prev_entry_hash equals the first entry_hash', async () => {
    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await consumer.consume(tx1, event({ eventId: 'evt-1' }))
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await consumer.consume(tx2, event({ eventId: 'evt-2', payload: basePayload({ entityId: 'emp-2' }) }))
    await tx2.query('COMMIT')

    const rows = db.debugEntries()
    expect(rows).toHaveLength(2)
    expect(rows[1]?.prev_entry_hash).toBe(rows[0]?.entry_hash)
  })

  it('rejects a .sensitive.read action with no purpose — no entry is written, and the event is not marked processed (redeliverable)', async () => {
    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()

    await tx.query('BEGIN')
    await expect(consumer.consume(tx, event({ payload: basePayload({ action: 'employee.sensitive.read' }) }))).rejects.toThrow(
      /purpose/i,
    )
    await tx.query('ROLLBACK')

    expect(db.debugEntries()).toHaveLength(0)

    // Redelivery with a valid purpose must succeed, not be treated as a duplicate.
    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const result = await consumer.consume(
      tx2,
      event({ payload: basePayload({ action: 'employee.sensitive.read', purpose: 'payroll export' }) }),
    )
    await tx2.query('COMMIT')

    expect(result).toBe('applied')
    expect(db.debugEntries()).toHaveLength(1)
  })

  it('rejects a .sensitive.read action with a whitespace-only purpose', async () => {
    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()

    await tx.query('BEGIN')
    await expect(
      consumer.consume(tx, event({ payload: basePayload({ action: 'employee.sensitive.read', purpose: '   ' }) })),
    ).rejects.toThrow(/purpose/i)
    await tx.query('ROLLBACK')

    expect(db.debugEntries()).toHaveLength(0)
  })

  it('accepts a .sensitive.read action that carries a purpose', async () => {
    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()

    await tx.query('BEGIN')
    const result = await consumer.consume(
      tx,
      event({ payload: basePayload({ action: 'employee.sensitive.read', purpose: 'payroll export' }) }),
    )
    await tx.query('COMMIT')

    expect(result).toBe('applied')
    expect(db.debugEntries()[0]?.purpose).toBe('payroll export')
  })

  it('a non-sensitive action with no before/after stores null hashes, not a hash of null', async () => {
    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()

    await tx.query('BEGIN')
    await consumer.consume(tx, event({ payload: basePayload({ before: undefined, after: undefined }) }))
    await tx.query('COMMIT')

    const row = db.debugEntries()[0]
    expect(row?.before_hash).toBeNull()
    expect(row?.after_hash).toBeNull()
  })

  it('the inserted entry_hash matches an independent recomputation via chain.ts', async () => {
    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()

    await tx.query('BEGIN')
    await consumer.consume(tx, event())
    await tx.query('COMMIT')

    const row = db.debugEntries()[0]
    if (row === undefined) throw new Error('unreachable')
    const recomputed = computeEntryHash(row.prev_entry_hash, {
      occurredAt: row.occurred_at.toISOString(),
      actorId: row.actor_id,
      actorRole: row.actor_role,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      purpose: row.purpose,
      beforeHash: row.before_hash,
      afterHash: row.after_hash,
    })
    expect(recomputed).toBe(row.entry_hash)
  })
})

describe('parseAuditPayload', () => {
  it('rejects a non-object payload', () => {
    expect(() => parseAuditPayload('not an object')).toThrow()
    expect(() => parseAuditPayload(null)).toThrow()
    expect(() => parseAuditPayload(undefined)).toThrow()
  })

  it.each(['actorId', 'actorRole', 'action', 'entity', 'entityId'])('rejects a payload missing required field %s', (field) => {
    const payload = basePayload()
    delete payload[field]
    expect(() => parseAuditPayload(payload)).toThrow()
  })

  it('rejects a non-string purpose', () => {
    expect(() => parseAuditPayload(basePayload({ purpose: 123 }))).toThrow()
  })

  it('accepts a well-formed payload', () => {
    expect(parseAuditPayload(basePayload())).toMatchObject({ actorId: 'user-1', entity: 'employee' })
  })
})
