import type { Queryable } from '../outbox/outbox'
import { writeOutbox } from '../outbox/outbox'
import { isBlankPurpose } from '../crypto/client'
import { hashValue } from './canonical-json'

/**
 * Mirrors the roadmap's "Audit entry" shape (docs/superpowers/plans/00-PROGRAM-ROADMAP.md).
 * `before`/`after`/`purpose` map directly onto the eventual `audit.entry` row; the hash chain
 * (`before_hash`, `after_hash`, `prev_entry_hash`, `entry_hash`) is computed by the audit
 * consumer that reads this event off the outbox, not by the producer emitting it here.
 *
 * This is the CALLER-facing input shape only. `before`/`after` never reach the outbox as
 * values — see `AuditOutboxPayload` below and the "Audit payloads must carry hashes, not
 * values" note on `emit`.
 */
export interface AuditEntry {
  actorId: string
  actorRole: string
  action: string
  entity: string
  entityId: string
  purpose?: string
  before?: unknown
  after?: unknown
}

/**
 * The wire shape actually written to `outbox.payload` (and from there, the
 * broker, and `svc-audit`'s consumer). Everything from `AuditEntry` except
 * `before`/`after`, which are replaced by their hashes — this type is the
 * enforcement mechanism for "no raw value reaches the outbox": there is no
 * field on this interface a raw `before`/`after` could be assigned into.
 */
interface AuditOutboxPayload {
  actorId: string
  actorRole: string
  action: string
  entity: string
  entityId: string
  purpose?: string
  beforeHash: string | null
  afterHash: string | null
}

const SENSITIVE_READ_SUFFIX = '.sensitive.read'

/**
 * `null`/`undefined` (a create has no `before`, a delete has no `after`)
 * must stay `null` in the payload — never `hashValue(null)`, which hashes
 * the canonical JSON string `"null"` and would make "no value" wire-
 * identical to "the value is the JSON literal null".
 */
function hashOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : hashValue(value)
}

/**
 * Emits an `audit.<action>` event to the caller's outbox. This takes the
 * caller's transaction (`tx`) and writes through `writeOutbox`, the same
 * atomicity primitive Task 4 built — deliberately not its own connection —
 * so an audit entry can never survive a write that rolled back, and can
 * never be lost for a write that committed (carried-forward binding note).
 */
export class AuditEmitter {
  async emit(tx: Queryable, schema: string, entry: AuditEntry): Promise<void> {
    // roadmap: "Every S3 field read emits an audit entry carrying a
    // mandatory purpose." `.sensitive.read` actions are exactly those S3
    // reads, so a missing or blank purpose must reject before anything is
    // written — never fall back to an empty string. "Blank" is
    // `isBlankPurpose` from crypto/client.ts, the one definition of that
    // term for the whole kernel (fix round 1, IMPORTANT 6) — a PDPA
    // requirement must not have two divergent definitions of what counts
    // as satisfying it, one of them weaker and guarding the audit record.
    if (entry.action.endsWith(SENSITIVE_READ_SUFFIX) && (entry.purpose === undefined || isBlankPurpose(entry.purpose))) {
      throw new Error(`AuditEmitter.emit: action "${entry.action}" requires a non-empty purpose`)
    }

    // roadmap "Audit payloads must carry hashes, not values" (added
    // 2026-08-02, Task 5 review; closed here by Task 9b). `before`/`after`
    // are hashed BEFORE the outbox INSERT, so a salary or national ID never
    // sits in `outbox.payload` as plaintext `jsonb` — not even transiently
    // until the relay reaps the row, and not in flight on the broker
    // either. A consumer that needs the actual value fetches it through the
    // owning service's audited API, same as for any other S3 field.
    const payload: AuditOutboxPayload = {
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      beforeHash: hashOrNull(entry.before),
      afterHash: hashOrNull(entry.after),
    }
    if (entry.purpose !== undefined) {
      payload.purpose = entry.purpose
    }

    await writeOutbox(tx, schema, `audit.${entry.action}`, payload)
  }
}
