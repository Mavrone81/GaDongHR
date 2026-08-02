import { createHash as independentCreateHash } from 'node:crypto'
import { canonicalJson, hashValue, sha256Hex } from './canonical-json'

describe('canonicalJson', () => {
  it('is order-independent: same keys in different insertion order produce identical output', () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } }
    const b = { a: 2, c: { x: 2, y: 1 }, b: 1 }

    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })

  it('keeps array element order (order is semantic content, not incidental)', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]))
  })

  it('folds undefined to null so it always returns a string', () => {
    expect(canonicalJson(undefined)).toBe('null')
    expect(canonicalJson({ a: undefined })).toBe('{"a":null}')
  })

  it('recurses into nested arrays and objects', () => {
    const value = { list: [{ z: 1, a: 2 }, { b: 3 }] }
    expect(canonicalJson(value)).toBe('{"list":[{"a":2,"z":1},{"b":3}]}')
  })
})

describe('hashValue', () => {
  it('is deterministic across calls for the same logical value', () => {
    const value = { salary: 45000, nationalId: '1101700207364' }
    expect(hashValue(value)).toBe(hashValue(value))
    expect(hashValue(value)).toBe(hashValue({ nationalId: '1101700207364', salary: 45000 }))
  })

  it('equals sha256Hex(canonicalJson(value)) by construction', () => {
    const value = { a: 1, b: [1, 2] }
    expect(hashValue(value)).toBe(sha256Hex(canonicalJson(value)))
  })

  it('produces different hashes for different values', () => {
    expect(hashValue({ salary: 45000 })).not.toBe(hashValue({ salary: 45001 }))
  })

  it('matches an independent reimplementation of the original svc-audit algorithm — regression guard for the Task 9b lift', () => {
    // Deliberately reproduced from scratch (not imported) rather than
    // reusing sortKeysDeep/canonicalJson above — the point of this test is
    // to catch this module's own algorithm silently drifting, which a test
    // built out of the same helper functions could never detect.
    function independentSortKeysDeep(value: unknown): unknown {
      if (value === undefined || value === null) return null
      if (Array.isArray(value)) return value.map(independentSortKeysDeep)
      if (typeof value === 'object') {
        const obj = value as Record<string, unknown>
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(obj).sort()) sorted[key] = independentSortKeysDeep(obj[key])
        return sorted
      }
      return value
    }
    function independentCanonicalJson(value: unknown): string {
      return JSON.stringify(independentSortKeysDeep(value))
    }
    function independentSha256Hex(input: string): string {
      return independentCreateHash('sha256').update(input, 'utf8').digest('hex')
    }

    const values: unknown[] = [
      { salary: 45000, nationalId: '1101700207364' },
      { b: 1, a: 2, c: { y: 1, x: 2 } },
      [1, { z: 1, a: 2 }, null, undefined],
      null,
      undefined,
      'plain-string',
      42,
    ]

    for (const value of values) {
      expect(canonicalJson(value)).toBe(independentCanonicalJson(value))
      expect(hashValue(value)).toBe(independentSha256Hex(independentCanonicalJson(value)))
    }
  })
})
