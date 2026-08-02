import { idempotent, isBlankPurpose } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { GENESIS_PREV_HASH, computeEntryHash, hashValue } from './chain'
import type { ChainContent } from './chain'
import { EntriesRepository } from './entries.repository'
import type { StoredEntry } from './chain'

const SENSITIVE_READ_SUFFIX = '.sensitive.read'

/**
 * The wire shape of an `audit.*` event payload, as received off the bus —
 * mirrors kernel's `AuditEntry` (`packages/kernel/src/audit/emitter.ts`),
 * which is what every producer's `AuditEmitter.emit` writes into its own
 * outbox. Re-declared here (not imported) because this is the untrusted,
 * `unknown`-until-validated shape a consumer receives, not the producer's
 * already-typed input.
 */
export interface RawAuditPayload {
  actorId: string
  actorRole: string
  action: string
  entity: string
  entityId: string
  purpose?: string
  before?: unknown
  after?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * Fails closed: a payload missing any required field, or whose optional
 * `purpose` is present but not a string, is rejected outright rather than
 * coerced or defaulted. This is the audit trail itself — a best-effort
 * parse here is a hole in the one record meant to prove holes don't exist.
 */
export function parseAuditPayload(payload: unknown): RawAuditPayload {
  if (!isRecord(payload)) throw new Error('AuditConsumer: event payload is not an object')
  const { actorId, actorRole, action, entity, entityId, purpose, before, after } = payload
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('AuditConsumer: missing or invalid actorId')
  if (typeof actorRole !== 'string' || actorRole.length === 0) throw new Error('AuditConsumer: missing or invalid actorRole')
  if (typeof action !== 'string' || action.length === 0) throw new Error('AuditConsumer: missing or invalid action')
  if (typeof entity !== 'string' || entity.length === 0) throw new Error('AuditConsumer: missing or invalid entity')
  if (typeof entityId !== 'string' || entityId.length === 0) throw new Error('AuditConsumer: missing or invalid entityId')
  if (purpose !== undefined && typeof purpose !== 'string') throw new Error('AuditConsumer: purpose must be a string when present')
  return { actorId, actorRole, action, entity, entityId, purpose, before, after }
}

export interface RawAuditEvent {
  eventId: string
  topic: string
  payload: unknown
}

/**
 * Consumes one `audit.*` event and appends exactly one chained
 * `audit.entry` row. There is no write endpoint anywhere in this service —
 * this is the ONLY path an entry is ever created through (Task 9 brief:
 * "Entries arrive only by consuming `audit.*` events via the kernel's
 * `idempotent` wrapper").
 *
 * Two fail-closed properties, both re-checked here rather than trusted from
 * the producer:
 *
 *  - Idempotency: `idempotent()` (kernel) keys on `event.eventId` against
 *    `audit.processed_events`, so the same event delivered any number of
 *    times produces exactly one entry (XC-EVENTS).
 *  - Mandatory purpose on `.sensitive.read`: `AuditEmitter.emit` already
 *    enforces this at every producer, but a consumer that trusted the
 *    producer would have a hole the moment any future producer bypasses
 *    the kernel emitter, or a message is replayed/forged on the bus. Using
 *    kernel's `isBlankPurpose` — not a re-implementation — keeps this the
 *    one definition of "blank" for the whole system (same reasoning as
 *    `AuditEmitter.emit`'s own check).
 *
 * The read of the current chain head (`repo.findLatest`) and the insert of
 * the new entry happen inside the same transaction `idempotent` drives, so
 * two concurrent deliveries can never both compute a `prev_entry_hash`
 * pointing at the same predecessor.
 *
 * `before`/`after` never reach `audit.entry` as values — only
 * `hashValue(before)`/`hashValue(after)` do (roadmap "Audit payloads must
 * carry hashes, not values"). NOTE (deviation, see task report): the
 * current `AuditEmitter.emit` (packages/kernel, out of this service's
 * ownership) still places the raw `before`/`after` objects into the outbox
 * payload rather than hashing them before they reach the outbox, which is
 * what the roadmap's Task 5 review actually calls for. This consumer
 * closes the gap on its own side of the boundary — nothing unhashed is
 * ever written to `audit.entry` — but cannot close the producer-side leak
 * (raw value transiently in the producing service's `outbox` table and in
 * flight on the broker) without editing kernel, which is out of scope here.
 */
export class AuditConsumer {
  constructor(
    private readonly repo: EntriesRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(tx: Queryable, event: RawAuditEvent): Promise<'applied' | 'duplicate'> {
    const outcome = await idempotent(tx, 'audit', event.eventId, async (): Promise<StoredEntry> => {
      const entry = parseAuditPayload(event.payload)

      if (entry.action.endsWith(SENSITIVE_READ_SUFFIX) && (entry.purpose === undefined || isBlankPurpose(entry.purpose))) {
        throw new Error(`AuditConsumer: action "${entry.action}" requires a non-empty purpose and none was carried`)
      }

      const prev = await this.repo.findLatest(tx)
      const prevEntryHash = prev?.entryHash ?? GENESIS_PREV_HASH

      const content: ChainContent = {
        occurredAt: this.now().toISOString(),
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        purpose: entry.purpose ?? null,
        beforeHash: entry.before !== undefined ? hashValue(entry.before) : null,
        afterHash: entry.after !== undefined ? hashValue(entry.after) : null,
      }
      const entryHash = computeEntryHash(prevEntryHash, content)

      return this.repo.insert(tx, { ...content, prevEntryHash, entryHash })
    })

    return outcome === 'duplicate' ? 'duplicate' : 'applied'
  }
}
