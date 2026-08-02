import type { Queryable } from '@gadong/kernel'
import { AuditEmitter } from '@gadong/kernel'
import type { AuditEntry } from '@gadong/kernel'
import { AuditConsumer } from './consumer'
import type { RawAuditEvent } from './consumer'
import { EntriesRepository } from './entries.repository'
import { FakeAuditDb } from './testing/fake-db'
import { GENESIS_PREV_HASH, hashValue, verifyChain } from './chain'

/**
 * This file exists to close the exact hole `task-9c` fixed: every OTHER
 * test in this package (`consumer.test.ts` included) hand-writes its own
 * payload fixture, in whatever shape the author of that test believed the
 * wire carried. Two independently hand-written fixtures that agree with
 * each other prove nothing about whether they agree with the REAL producer
 * — which is exactly how `services/svc-audit/src/consumer.ts` kept reading
 * a `before`/`after` shape for a full task-cycle after
 * `packages/kernel/src/audit/emitter.ts` (commit `bae5a8a`) stopped sending
 * it: 515 tests green, no compile error, every stored hash silently `null`.
 *
 * Every payload here is produced by the REAL `@gadong/kernel` `AuditEmitter`
 * — the actual producer, not a fixture shaped like it — via
 * `CapturingOutboxTx`, a `Queryable` that only understands the one SQL
 * shape `writeOutbox` issues (`INSERT INTO <schema>.outbox ...`) and hands
 * back the parsed JSON payload. That is the full extent of what's faked:
 * everything from `AuditEntry` in to `outbox.payload` out is the real
 * kernel code path.
 */
class CapturingOutboxTx implements Queryable {
  public lastPayload: unknown

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()
    if (/^INSERT INTO\s+\S*\.outbox\b/i.test(s)) {
      const [, payloadJson] = params as [string, string]
      this.lastPayload = JSON.parse(payloadJson as string)
      return { rows: [{ id: 'captured-outbox-row' }] }
    }
    throw new Error(`CapturingOutboxTx: unexpected query — AuditEmitter.emit should only ever INSERT INTO <schema>.outbox: ${s}`)
  }
}

const FIXED_NOW = new Date('2026-08-02T09:00:00.000Z')

/** Runs the real `AuditEmitter.emit` and returns the exact JSON payload it put on the wire. */
async function emitReal(entry: AuditEntry): Promise<unknown> {
  const tx = new CapturingOutboxTx()
  await new AuditEmitter().emit(tx, 'onboarding', entry)
  return tx.lastPayload
}

function toEvent(eventId: string, payload: unknown): RawAuditEvent {
  return { eventId, topic: 'audit.employee.update', payload }
}

describe('kernel AuditEmitter <-> svc-audit AuditConsumer wire contract (round-trip through the real emitter)', () => {
  it('round-trips a real emitter payload: the consumer stores exactly the beforeHash/afterHash the emitter computed, with no re-hashing', async () => {
    const before = { salary: 45000, nationalId: '1101700207364' }
    const after = { salary: 47000, nationalId: '1101700207364' }
    const payload = await emitReal({
      actorId: 'user-1',
      actorRole: 'hr-officer',
      action: 'employee.update',
      entity: 'employee',
      entityId: 'emp-1',
      before,
      after,
    })

    // Sanity on the producer side of the seam: the real emitter hashes,
    // it does not carry raw sensitive values (bae5a8a's own guarantee).
    const serialisedPayload = JSON.stringify(payload)
    expect(serialisedPayload).not.toContain('45000')
    expect(serialisedPayload).not.toContain('1101700207364')

    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()

    await tx.query('BEGIN')
    const result = await consumer.consume(tx, toEvent('evt-real-1', payload))
    await tx.query('COMMIT')

    expect(result).toBe('applied')
    const row = db.debugEntries()[0]

    // The consumer stored the same hash the shared canonicaliser produces
    // independently from the plaintext values...
    expect(row?.before_hash).toBe(hashValue(before))
    expect(row?.after_hash).toBe(hashValue(after))
    // ...AND the exact value the emitter itself put on the wire — proving
    // the consumer read it through, rather than recomputing (recomputing
    // `hashValue(payload.beforeHash)` would silently produce a DIFFERENT
    // string here, since `payload.beforeHash` is already a hash).
    expect(row?.before_hash).toBe((payload as { beforeHash: string }).beforeHash)
    expect(row?.after_hash).toBe((payload as { afterHash: string }).afterHash)
  })

  it('a create (no before) through the real emitter stores a null before_hash — legitimate — and chain verification still passes', async () => {
    const payload = await emitReal({
      actorId: 'user-1',
      actorRole: 'hr-officer',
      action: 'employee.create',
      entity: 'employee',
      entityId: 'emp-2',
      after: { status: 'active' },
    })

    const db = new FakeAuditDb()
    const repo = new EntriesRepository(db.asPool())
    const consumer = new AuditConsumer(repo, () => FIXED_NOW)
    const tx = db.connect()
    await tx.query('BEGIN')
    await consumer.consume(tx, toEvent('evt-create', payload))
    await tx.query('COMMIT')

    const row = db.debugEntries()[0]
    expect(row?.before_hash).toBeNull()
    expect(row?.after_hash).toBe(hashValue({ status: 'active' }))

    // Same walk `/verify` (entries.service.ts) runs in production.
    const chainResult = verifyChain(await repo.findAllOrdered())
    expect(chainResult.valid).toBe(true)
  })

  it('a delete (no after) through the real emitter stores a null after_hash — legitimate, not an error', async () => {
    const payload = await emitReal({
      actorId: 'user-1',
      actorRole: 'hr-officer',
      action: 'employee.delete',
      entity: 'employee',
      entityId: 'emp-9',
      before: { status: 'on-leave' },
    })

    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()
    await tx.query('BEGIN')
    await consumer.consume(tx, toEvent('evt-delete', payload))
    await tx.query('COMMIT')

    const row = db.debugEntries()[0]
    expect(row?.before_hash).toBe(hashValue({ status: 'on-leave' }))
    expect(row?.after_hash).toBeNull()
  })

  it('a sequence of create/update/delete built entirely through the real emitter chains correctly end to end and verifies clean', async () => {
    const db = new FakeAuditDb()
    const repo = new EntriesRepository(db.asPool())
    const consumer = new AuditConsumer(repo, () => FIXED_NOW)

    const steps: Array<{ eventId: string; entry: AuditEntry }> = [
      {
        eventId: 'evt-1',
        entry: {
          actorId: 'user-1',
          actorRole: 'hr-officer',
          action: 'employee.create',
          entity: 'employee',
          entityId: 'emp-3',
          after: { status: 'active' },
        },
      },
      {
        eventId: 'evt-2',
        entry: {
          actorId: 'user-1',
          actorRole: 'hr-officer',
          action: 'employee.update',
          entity: 'employee',
          entityId: 'emp-3',
          before: { status: 'active' },
          after: { status: 'on-leave' },
        },
      },
      {
        eventId: 'evt-3',
        entry: {
          actorId: 'user-1',
          actorRole: 'hr-officer',
          action: 'employee.delete',
          entity: 'employee',
          entityId: 'emp-3',
          before: { status: 'on-leave' },
        },
      },
    ]

    for (const { eventId, entry } of steps) {
      const payload = await emitReal(entry)
      const tx = db.connect()
      await tx.query('BEGIN')
      const result = await consumer.consume(tx, toEvent(eventId, payload))
      await tx.query('COMMIT')
      expect(result).toBe('applied')
    }

    const rows = db.debugEntries()
    expect(rows).toHaveLength(3)
    expect(rows[0]?.prev_entry_hash).toBe(GENESIS_PREV_HASH)
    expect(rows[1]?.prev_entry_hash).toBe(rows[0]?.entry_hash)
    expect(rows[2]?.prev_entry_hash).toBe(rows[1]?.entry_hash)
    // Never null-by-accident along the way — this is the property that was
    // silently false in production before task-9c: null hashes for every
    // entry, chain intact but proving nothing.
    expect(rows[0]?.before_hash).toBeNull()
    expect(rows[0]?.after_hash).not.toBeNull()
    expect(rows[1]?.before_hash).not.toBeNull()
    expect(rows[1]?.after_hash).not.toBeNull()
    expect(rows[2]?.before_hash).not.toBeNull()
    expect(rows[2]?.after_hash).toBeNull()

    const chainResult = verifyChain(await repo.findAllOrdered())
    expect(chainResult).toMatchObject({ valid: true, entryCount: 3, issues: [] })
  })

  it('a malformed payload (real emitter shape with beforeHash/afterHash stripped) is rejected, not silently stored as null hashes', async () => {
    const payload = (await emitReal({
      actorId: 'user-1',
      actorRole: 'hr-officer',
      action: 'employee.update',
      entity: 'employee',
      entityId: 'emp-4',
      before: { status: 'active' },
      after: { status: 'terminated' },
    })) as Record<string, unknown>
    delete payload['beforeHash']
    delete payload['afterHash']

    const db = new FakeAuditDb()
    const consumer = new AuditConsumer(new EntriesRepository(db.asPool()), () => FIXED_NOW)
    const tx = db.connect()

    await tx.query('BEGIN')
    await expect(consumer.consume(tx, toEvent('evt-malformed', payload))).rejects.toThrow(/beforeHash|afterHash/)
    await tx.query('ROLLBACK')

    expect(db.debugEntries()).toHaveLength(0)
  })
})
