import { idempotent, isBlankPurpose } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { GENESIS_PREV_HASH, computeEntryHash } from './chain'
import type { ChainContent } from './chain'
import { EntriesRepository } from './entries.repository'
import type { StoredEntry } from './chain'

const SENSITIVE_READ_SUFFIX = '.sensitive.read'

/**
 * The wire shape of an `audit.*` event payload, as received off the bus —
 * mirrors kernel's `AuditOutboxPayload` (`packages/kernel/src/audit/emitter.ts`,
 * not exported, but this is its shape), which is what every producer's
 * `AuditEmitter.emit` actually writes into its own outbox as of commit
 * `bae5a8a` ("Audit payloads must carry hashes, not values"). Re-declared
 * here (not imported) because this is the untrusted, `unknown`-until-
 * validated shape a consumer receives, not the producer's already-typed
 * input.
 *
 * Carries `beforeHash`/`afterHash` — SHA-256 of canonical JSON, computed by
 * the emitter — NOT raw `before`/`after`. Those values never reach the
 * outbox, the broker, or this consumer at all (that is the point of
 * `bae5a8a`: a salary or national ID must never sit in cleartext in the
 * outbox while being encrypted in its own column). There is nothing for
 * this consumer to hash — hashing `beforeHash` again would produce a
 * different value than the emitter's, and silently break every chain
 * verification. See `parseAuditPayload` for what happens to a payload that
 * doesn't carry these fields.
 */
export interface RawAuditPayload {
  actorId: string
  actorRole: string
  action: string
  entity: string
  entityId: string
  purpose?: string
  beforeHash: string | null
  afterHash: string | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * Fails closed: a payload missing any required field, or whose optional
 * `purpose` is present but not a string, is rejected outright rather than
 * coerced or defaulted. This is the audit trail itself — a best-effort
 * parse here is a hole in the one record meant to prove holes don't exist.
 *
 * `beforeHash`/`afterHash` are REQUIRED keys (each `string | null` — `null`
 * is the legitimate "no before"/"no after" case for a create/delete). A
 * payload that carries neither of these keys — because it's malformed, or
 * because it's the pre-`bae5a8a` legacy shape (raw `before`/`after`, no
 * hash fields) — is rejected outright rather than silently stored as null
 * hashes. That silent-null path is exactly the defect this function closes:
 * treating an unrecognised shape as "no value" is indistinguishable, once
 * written, from a genuine create/delete, and produces a tamper-evident
 * chain built over hashes that were never computed from anything. A
 * partial payload (only one of the two hash keys present) is equally
 * rejected — the emitter always sets both, so a partial payload cannot come
 * from `AuditEmitter.emit` and is itself evidence of a shape this consumer
 * does not understand.
 *
 * Legacy `before`/`after` payloads are deliberately NOT tolerated as a
 * fallback (no re-hashing here, ever — see the class doc on
 * `AuditConsumer.consume`). If a caller is found emitting the legacy shape
 * in production, that is a producer bug to fix at the source, not a shape
 * for this consumer to accommodate.
 */
export function parseAuditPayload(payload: unknown): RawAuditPayload {
  if (!isRecord(payload)) throw new Error('AuditConsumer: event payload is not an object')
  const { actorId, actorRole, action, entity, entityId, purpose, beforeHash, afterHash } = payload
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('AuditConsumer: missing or invalid actorId')
  if (typeof actorRole !== 'string' || actorRole.length === 0) throw new Error('AuditConsumer: missing or invalid actorRole')
  if (typeof action !== 'string' || action.length === 0) throw new Error('AuditConsumer: missing or invalid action')
  if (typeof entity !== 'string' || entity.length === 0) throw new Error('AuditConsumer: missing or invalid entity')
  if (typeof entityId !== 'string' || entityId.length === 0) throw new Error('AuditConsumer: missing or invalid entityId')
  if (purpose !== undefined && typeof purpose !== 'string') throw new Error('AuditConsumer: purpose must be a string when present')
  if (beforeHash === undefined && afterHash === undefined) {
    throw new Error(
      'AuditConsumer: payload carries neither beforeHash/afterHash nor a recognised legacy shape — refusing to store null hashes for an unrecognised payload shape (see parseAuditPayload doc comment)',
    )
  }
  if (beforeHash === undefined || afterHash === undefined) {
    throw new Error(
      'AuditConsumer: payload carries only one of beforeHash/afterHash — AuditEmitter.emit always sets both, so this is a malformed or truncated event, not a legitimate create/delete',
    )
  }
  if (beforeHash !== null && typeof beforeHash !== 'string') throw new Error('AuditConsumer: beforeHash must be a string or null when present')
  if (afterHash !== null && typeof afterHash !== 'string') throw new Error('AuditConsumer: afterHash must be a string or null when present')
  return { actorId, actorRole, action, entity, entityId, purpose, beforeHash, afterHash }
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
 * `before`/`after` never reach `audit.entry` as values — this consumer
 * never sees them in the first place. Since `bae5a8a`, `AuditEmitter.emit`
 * (packages/kernel) hashes `before`/`after` before the outbox INSERT, using
 * the same canonicaliser (`@gadong/kernel`'s `canonicalJson`/`hashValue`,
 * re-exported from `./chain`) this service's own chain math is built on.
 * The payload that reaches this consumer therefore already carries
 * `beforeHash`/`afterHash` — `parseAuditPayload` reads them straight off
 * the wire and `consume` stores them unchanged. There is no re-hashing
 * here: hashing an already-hashed value would produce a different digest
 * than the one the emitter computed, silently breaking every chain
 * verification downstream (this was a real, shipped defect — see
 * `.superpowers/sdd/01-foundation-platform/task-9c-report.md`).
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
        beforeHash: entry.beforeHash,
        afterHash: entry.afterHash,
      }
      const entryHash = computeEntryHash(prevEntryHash, content)

      return this.repo.insert(tx, { ...content, prevEntryHash, entryHash })
    })

    return outcome === 'duplicate' ? 'duplicate' : 'applied'
  }
}
