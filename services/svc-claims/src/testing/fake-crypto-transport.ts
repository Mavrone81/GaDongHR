import { randomBytes } from 'node:crypto'
import type { CryptoTransport } from '@gadong/kernel'

/**
 * `CryptoClient`'s (kernel) floor for what counts as plausible ciphertext —
 * duplicated here rather than imported, matching
 * `services/svc-docs/src/testing/fake-crypto-transport.ts`'s own comment:
 * this fake deliberately does not depend on `svc-crypto`'s real envelope
 * format; it only needs to produce something the same LENGTH a real
 * envelope would be.
 */
const MIN_CIPHERTEXT_BYTES = 125

/** Fixed, non-secret keystream — test fixture only, not a security boundary. */
const KEYSTREAM = Buffer.from('svc-claims-fake-crypto-transport-fixture-keystream-not-for-production-use')

function xor(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i]! ^ KEYSTREAM[i % KEYSTREAM.length]!
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * Stands in for `svc-crypto` — there is no live `svc-crypto` in this
 * environment (Task 14 brief CONSTRAINTS). Reversibly obfuscates the
 * plaintext with a fixed XOR keystream (not a plaintext-echoing fake), so
 * "the stored `file_ref` is ciphertext, never the plaintext receipt
 * pointer" exercises a real property — the stored bytes genuinely do not
 * contain the plaintext pointer as a substring — the same property real
 * envelope encryption guarantees.
 */
export function fakeCryptoTransport(): CryptoTransport {
  return {
    async post(path: string, body: unknown): Promise<unknown> {
      if (path === '/encrypt') {
        if (!isRecord(body) || !Array.isArray(body['fields'])) throw new Error('fakeCryptoTransport: malformed /encrypt body')
        const fields = body['fields'] as Array<{ field: string; value: string }>
        const out: Record<string, string> = {}
        for (const f of fields) {
          const plain = Buffer.from(f.value, 'utf8')
          const lenPrefix = Buffer.alloc(4)
          lenPrefix.writeUInt32BE(plain.length, 0)
          const obfuscated = xor(Buffer.concat([lenPrefix, plain]))
          const padding = randomBytes(Math.max(0, MIN_CIPHERTEXT_BYTES - obfuscated.length))
          out[f.field] = Buffer.concat([obfuscated, padding]).toString('base64')
        }
        return { fields: out }
      }

      if (path === '/decrypt') {
        if (!isRecord(body) || typeof body['ciphertext'] !== 'string') throw new Error('fakeCryptoTransport: malformed /decrypt body')
        const raw = Buffer.from(body['ciphertext'], 'base64')
        const deobfuscated = xor(raw)
        const len = deobfuscated.readUInt32BE(0)
        const plain = deobfuscated.subarray(4, 4 + len)
        return { value: plain.toString('utf8') }
      }

      throw new Error(`fakeCryptoTransport: unexpected path ${path}`)
    },
  }
}
