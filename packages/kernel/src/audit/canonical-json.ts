import { createHash } from 'node:crypto'

/**
 * Canonical JSON + SHA-256 hashing, shared by every producer's
 * `AuditEmitter` (`emitter.ts`, this directory) and `svc-audit`'s hash chain
 * (`services/svc-audit/src/chain.ts`, which imports `canonicalJson`,
 * `hashValue`, and `sha256Hex` from here rather than keeping its own copy).
 *
 * Lifted into the kernel by Task 9b (originally `services/svc-audit/src/chain.ts`,
 * Task 9) because the two sides MUST produce byte-identical output for the
 * same logical value: the producer hashes `before`/`after` once, here,
 * before the outbox INSERT; the audit chain later recomputes `entry_hash`
 * from the stored `before_hash`/`after_hash` and expects the walk in
 * `verifyChain`'s `content_mismatch` check to reproduce it. Two
 * hand-maintained copies of "sort keys, stringify" are one accidental
 * divergence (a different key-sort, a different treatment of `undefined`)
 * away from every entry's hash silently going wrong — importing the same
 * function from one place makes that divergence impossible rather than
 * merely tested against.
 */

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Recursively sorts every object's keys so two objects with the same keys
 * in a different insertion order canonicalise identically —
 * `JSON.stringify` alone preserves insertion order, which is exactly what
 * canonical JSON must NOT be sensitive to. Arrays keep their order (element
 * order is semantic content, not incidental like key insertion order).
 * `undefined` (from an omitted/optional field surviving into this call) is
 * folded to `null` so this function is total — `JSON.stringify(undefined)`
 * returns `undefined`, not a string, which would otherwise make
 * `canonicalJson` occasionally not return a `string` at all.
 */
function sortKeysDeep(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null) return null
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key])
    }
    return sorted
  }
  return value
}

/** Deterministic JSON: same logical content, same string, regardless of source key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

/**
 * `SHA256(canonical_json(value))` — used for `before_hash`/`after_hash`: the
 * audit trail records that a value changed and can prove which value later
 * (by re-hashing a value fetched, with purpose, through the owning
 * service's audited API), without ever holding the value itself (roadmap
 * "Audit payloads must carry hashes, not values").
 *
 * Callers that need to distinguish "no value" (a create has no `before`, a
 * delete has no `after`) from an actual value must check for `null`/
 * `undefined` themselves before calling this — `hashValue(null)` and
 * `hashValue(undefined)` both hash the canonical JSON string `"null"`,
 * which is a real (if unlikely) value's hash, not the absence of one.
 */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
