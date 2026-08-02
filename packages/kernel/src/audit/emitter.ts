import type { Queryable } from '../outbox/outbox'
import { writeOutbox } from '../outbox/outbox'

/**
 * Mirrors the roadmap's "Audit entry" shape (docs/superpowers/plans/00-PROGRAM-ROADMAP.md).
 * `before`/`after`/`purpose` map directly onto the eventual `audit.entry` row; the hash chain
 * (`before_hash`, `after_hash`, `prev_entry_hash`, `entry_hash`) is computed by the audit
 * consumer that reads this event off the outbox, not by the producer emitting it here.
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

const SENSITIVE_READ_SUFFIX = '.sensitive.read'

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0
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
    // reads, so a missing or whitespace-only purpose must reject before
    // anything is written — never fall back to an empty string.
    if (entry.action.endsWith(SENSITIVE_READ_SUFFIX) && isBlank(entry.purpose)) {
      throw new Error(`AuditEmitter.emit: action "${entry.action}" requires a non-empty purpose`)
    }

    await writeOutbox(tx, schema, `audit.${entry.action}`, entry)
  }
}
