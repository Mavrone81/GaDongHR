import { createHmac } from 'node:crypto'

/**
 * Re-derives `computePackSignature` from
 * `services/svc-config/src/packs.service.ts` exactly (HMAC-SHA256 over a
 * recursively-key-sorted JSON canonicalisation of {pack_id, version,
 * records}) rather than importing the compiled service — this harness has
 * no build dependency on svc-config's own dist output. Any drift between
 * this and the real implementation would show up immediately as CFG-401
 * (`config.error.pack_signature_invalid`) on import, so it cannot silently
 * diverge unnoticed.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

export interface PackRecord {
  rule_key: string
  value: unknown
  unit: string
  statutory_floor?: unknown
  statutory_ceiling?: unknown
  citation: string
  effective_from: string
  effective_to?: string | null
  governance_class: string
}

export interface SignedPack {
  pack_id: string
  version: number
  signature: string
  records: PackRecord[]
}

export function signPack(pack: { pack_id: string; version: number; records: PackRecord[] }, signingKey: string): SignedPack {
  const signature = createHmac('sha256', signingKey).update(canonicalJson(pack)).digest('base64')
  return { pack_id: pack.pack_id, version: pack.version, records: pack.records, signature }
}
