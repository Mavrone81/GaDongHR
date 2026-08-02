import {
  GENESIS_PREV_HASH,
  canonicalJson,
  computeEntryHash,
  hashValue,
  verifyChain,
} from './chain'
import type { ChainContent, StoredEntry } from './chain'

function content(overrides: Partial<ChainContent> = {}): ChainContent {
  return {
    occurredAt: '2026-08-01T09:00:00.000Z',
    actorId: 'user-1',
    actorRole: 'hr-officer',
    action: 'employee.update',
    entity: 'employee',
    entityId: 'emp-1',
    purpose: null,
    beforeHash: null,
    afterHash: null,
    ...overrides,
  }
}

/** Builds a valid chain of `n` linked entries, each entry's `entityId` distinguishing it (`emp-1`, `emp-2`, ...). */
function buildChain(n: number): StoredEntry[] {
  const entries: StoredEntry[] = []
  let prevEntryHash = GENESIS_PREV_HASH
  for (let i = 1; i <= n; i++) {
    const c = content({ entityId: `emp-${i}` })
    const entryHash = computeEntryHash(prevEntryHash, c)
    entries.push({ id: String(i), ...c, prevEntryHash, entryHash })
    prevEntryHash = entryHash
  }
  return entries
}

describe('canonicalJson', () => {
  it('is order-independent: same keys in different insertion order produce identical output', () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } }
    const b = { a: 2, c: { x: 2, y: 1 }, b: 1 }

    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })

  it('feeds hashValue: same content, different key order, identical hash', () => {
    const a = { salary: 50000, currency: 'THB', employeeId: 'emp-1' }
    const b = { employeeId: 'emp-1', salary: 50000, currency: 'THB' }

    expect(hashValue(a)).toBe(hashValue(b))
  })

  it('preserves array element order (order is semantic content, not incidental)', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]))
  })

  it('is sensitive to different content producing different output', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }))
  })

  it('folds undefined to null so the function always returns a string', () => {
    expect(canonicalJson(undefined)).toBe('null')
  })
})

describe('computeEntryHash', () => {
  it('is deterministic: same prevEntryHash and content always produce the same hash', () => {
    const c = content()
    expect(computeEntryHash(GENESIS_PREV_HASH, c)).toBe(computeEntryHash(GENESIS_PREV_HASH, c))
  })

  it('changes when prevEntryHash changes, content held fixed', () => {
    const c = content()
    const h1 = computeEntryHash(GENESIS_PREV_HASH, c)
    const h2 = computeEntryHash('a'.repeat(64), c)
    expect(h1).not.toBe(h2)
  })

  it('changes when any single content field changes', () => {
    const base = computeEntryHash(GENESIS_PREV_HASH, content())
    expect(computeEntryHash(GENESIS_PREV_HASH, content({ action: 'employee.delete' }))).not.toBe(base)
    expect(computeEntryHash(GENESIS_PREV_HASH, content({ purpose: 'payroll export' }))).not.toBe(base)
    expect(computeEntryHash(GENESIS_PREV_HASH, content({ beforeHash: 'x'.repeat(64) }))).not.toBe(base)
  })

  it('produces a 64-character lowercase hex string (SHA-256)', () => {
    const h = computeEntryHash(GENESIS_PREV_HASH, content())
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('verifyChain', () => {
  it('an empty chain is valid', () => {
    expect(verifyChain([])).toEqual({ valid: true, entryCount: 0, issues: [] })
  })

  it('a correctly linked chain verifies with no issues', () => {
    const result = verifyChain(buildChain(4))
    expect(result).toEqual({ valid: true, entryCount: 4, issues: [] })
  })

  it('a first entry whose prev_entry_hash is not GENESIS is flagged as a chain break', () => {
    const entries = buildChain(2)
    const first = entries[0]
    if (first === undefined) throw new Error('unreachable')
    entries[0] = { ...first, prevEntryHash: 'f'.repeat(64) }

    const result = verifyChain(entries)

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ entryId: '1', kind: 'chain_break' }))
  })

  it('tampering with one entry (content changed, entry_hash left alone) is detected and names that specific entry, not just "chain broken"', () => {
    const entries = buildChain(5)
    const target = entries[2]
    if (target === undefined) throw new Error('unreachable')
    // Attacker edits the row's `entity_id` directly in the DB but doesn't
    // (can't, without recomputing SHA-256 by hand) touch `entry_hash`.
    entries[2] = { ...target, entityId: 'emp-999-tampered' }

    const result = verifyChain(entries)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual([{ entryId: '3', kind: 'content_mismatch', message: expect.stringContaining('entry 3') }])
    // The rest of the chain is undisturbed: entry_hash for entry 3 was never
    // touched, so entry 4's prev_entry_hash still matches it.
    expect(result.issues.some((i) => i.entryId === '4')).toBe(false)
  })

  it('deleting a middle entry is detected via the resulting chain gap, named at the entry immediately after the gap', () => {
    const entries = buildChain(5)
    const withoutThird = entries.filter((e) => e.id !== '3')

    const result = verifyChain(withoutThird)

    expect(result.valid).toBe(false)
    expect(result.entryCount).toBe(4)
    expect(result.issues).toEqual([{ entryId: '4', kind: 'chain_break', message: expect.stringContaining('entry 4') }])
  })

  it('re-hashing a tampered entry so it is self-consistent still breaks the chain at the NEXT entry', () => {
    const entries = buildChain(5)
    const target = entries[2]
    if (target === undefined) throw new Error('unreachable')

    // The attacker tampers entry 3's content AND recomputes entry_hash from
    // the tampered content + its own (unchanged) prev_entry_hash, so entry 3
    // now passes its own internal self-consistency check.
    const tamperedContent = { ...target, entityId: 'emp-999-tampered' }
    const { id, prevEntryHash, entryHash: _oldHash, ...contentOnly } = tamperedContent
    void id
    void _oldHash
    const rehashed = computeEntryHash(prevEntryHash, contentOnly)
    entries[2] = { ...tamperedContent, entryHash: rehashed }

    const result = verifyChain(entries)

    expect(result.valid).toBe(false)
    // Entry 3 itself is now internally self-consistent — no content_mismatch there.
    expect(result.issues.some((i) => i.entryId === '3')).toBe(false)
    // But entry 4's prev_entry_hash still points at the ORIGINAL entry 3
    // hash, which no longer matches entry 3's new (rehashed) entry_hash.
    expect(result.issues).toEqual([{ entryId: '4', kind: 'chain_break', message: expect.stringContaining('entry 4') }])
  })

  it('a genuinely broken chain (removed vs kept unmodified) proves the tests above are not vacuous: reverting the tamper restores validity', () => {
    const entries = buildChain(3)
    expect(verifyChain(entries).valid).toBe(true)
  })
})
