import { canonicalJson, hashValue, sha256Hex } from '@gadong/kernel'

/**
 * Pure hash-chain core — no database, no NestJS, no I/O. Deliberately
 * separated from `entries.repository.ts`/`consumer.ts` so the chain's
 * tamper-evidence properties are provable with plain unit tests, not only
 * against a fake Postgres (Task 9 brief: "Put chaining in a pure `chain.ts`
 * so it is testable without a database").
 *
 * `entry_hash = SHA256(prev_entry_hash ‖ canonical_json(entry_without_hash))`
 * (roadmap "Audit entry"; Security doc §5). `entry_without_hash` here means
 * every entry column except the two hash-chain columns themselves
 * (`prev_entry_hash`, `entry_hash`) — `id` is also excluded, deliberately:
 * `id` is a `bigserial` Postgres assigns only once the row is INSERTed, so
 * a hash that depended on it could not be computed before the row exists
 * (chicken-and-egg). Ordering/tamper-evidence does not need it — that is
 * what `prev_entry_hash` chaining already provides; `id` only orders the
 * `/verify` walk (`ORDER BY id ASC`), it plays no part in any hash.
 *
 * `canonicalJson`/`hashValue`/`sha256Hex` are imported from `@gadong/kernel`
 * (Task 9b), not defined here, and re-exported below so every existing
 * import of them from this module keeps working unchanged. They used to be
 * defined in this file; they moved to the kernel because `AuditEmitter`
 * (`packages/kernel/src/audit/emitter.ts`) now hashes `before`/`after`
 * before they reach the outbox (closing the plaintext-in-outbox gap the
 * roadmap's "Audit payloads must carry hashes, not values" describes), and
 * that hash must be byte-for-byte identical to the one this chain
 * recomputes later — importing the same function from one place makes that
 * a compile-time guarantee instead of a "please keep two copies in sync"
 * convention.
 */
export { canonicalJson, hashValue, sha256Hex }

/** SHA-256 of an empty predecessor — the well-known constant every genuine chain's first entry must declare as its `prev_entry_hash`. Same length (64 hex chars) as every other link in the chain, so a genesis row is not a structurally different case `/verify` has to special-case. */
export const GENESIS_PREV_HASH = '0'.repeat(64)

/** Content fields hashed into `entry_hash`, everything on `audit.entry` except `id`, `prev_entry_hash`, and `entry_hash` itself. */
export interface ChainContent {
  occurredAt: string
  actorId: string
  actorRole: string
  action: string
  entity: string
  entityId: string
  purpose: string | null
  beforeHash: string | null
  afterHash: string | null
}

/** One stored `audit.entry` row, as `chain.ts` needs it: `ChainContent` plus the columns that place it in the chain. */
export interface StoredEntry extends ChainContent {
  id: string
  prevEntryHash: string
  entryHash: string
}

/** `entry_hash = SHA256(prev_entry_hash ‖ canonical_json(entry_without_hash))` — the concatenation is of the raw `prev_entry_hash` string with the canonical JSON string, not a JSON structure containing both (so `prev_entry_hash` is never re-encoded through `canonicalJson`, keeping the formula exactly as specified). */
export function computeEntryHash(prevEntryHash: string, content: ChainContent): string {
  return sha256Hex(prevEntryHash + canonicalJson(content))
}

export type ChainIssueKind = 'content_mismatch' | 'chain_break'

export interface ChainIssue {
  entryId: string
  kind: ChainIssueKind
  message: string
}

export interface VerifyResult {
  valid: boolean
  entryCount: number
  issues: ChainIssue[]
}

/**
 * Walks `entries` (must already be in chain order — ascending `id`, i.e.
 * insertion order) from genesis, and names every entry where the chain
 * fails to check out — never just "chain broken" (Task 9 brief: "a
 * reviewer will probe" that /verify names the specific entry).
 *
 * Two independent checks per entry, because they catch two different
 * failure modes and a reviewer can tamper with either one alone:
 *
 *  - `content_mismatch`: recomputing `entry_hash` from the entry's OWN
 *    stored `prev_entry_hash` and content doesn't reproduce its own stored
 *    `entry_hash`. This is what a naive tamper (edit a column, leave
 *    `entry_hash` alone) triggers — flagged at the tampered entry itself.
 *
 *  - `chain_break`: the entry's stored `prev_entry_hash` doesn't match the
 *    hash of the entry immediately before it in the walk (or, for the
 *    first entry, doesn't match `GENESIS_PREV_HASH`). This is what a
 *    *deletion* triggers (the next surviving entry's `prev_entry_hash`
 *    still points at the hash of the row that's now gone) — flagged at the
 *    entry AFTER the gap. It is also what a "re-hash the tampered entry so
 *    it's internally self-consistent" attack triggers: re-signing entry N
 *    changes N's `entry_hash` to a new value, but entry N+1's
 *    `prev_entry_hash` still holds the OLD value, so the break surfaces at
 *    N+1 even though N now passes its own `content_mismatch` check. This
 *    is the property that makes a *chain* worth having over a bag of
 *    individually-hashed rows: rewriting one entry's hash to cover your
 *    tracks always breaks its link to whatever comes next.
 *
 * `expectedPrev` is deliberately advanced using each entry's own STORED
 * `entryHash` (not a recomputed one) — the walk continues against what is
 * physically on disk, so a tampered-and-rehashed entry's new hash is what
 * the next entry is checked against, which is exactly what surfaces the
 * break at N+1 rather than masking it.
 */
export function verifyChain(entries: StoredEntry[]): VerifyResult {
  const issues: ChainIssue[] = []
  let expectedPrev = GENESIS_PREV_HASH

  for (const entry of entries) {
    const { id, prevEntryHash, entryHash, ...content } = entry

    const recomputed = computeEntryHash(prevEntryHash, content)
    if (recomputed !== entryHash) {
      issues.push({
        entryId: id,
        kind: 'content_mismatch',
        message: `entry ${id}: entry_hash does not match a recomputation from its own stored content and prev_entry_hash — this entry's content was modified after being written`,
      })
    }

    if (prevEntryHash !== expectedPrev) {
      issues.push({
        entryId: id,
        kind: 'chain_break',
        message: `entry ${id}: prev_entry_hash does not match the hash of the preceding entry in the chain — an entry was deleted or reordered, or a prior entry was re-hashed after being tampered with`,
      })
    }

    expectedPrev = entryHash
  }

  return { valid: issues.length === 0, entryCount: entries.length, issues }
}
