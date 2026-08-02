import { randomBytes } from 'node:crypto'
import type { CryptoTransport } from '@gadong/kernel'

/**
 * `CryptoClient`'s (kernel) floor for what counts as plausible ciphertext —
 * duplicated here rather than imported because this fake deliberately does
 * not depend on `svc-crypto`'s real envelope format (`envelope.ts` there
 * owns that); it only needs to produce something the same LENGTH a real
 * envelope would be, matching kernel `crypto/client.ts`'s `MIN_CIPHERTEXT_BYTES`.
 */
const MIN_CIPHERTEXT_BYTES = 125

/** Fixed, non-secret keystream — this is a test fixture, not a security boundary. Long enough that XOR-ing a realistic MinIO pointer JSON string against it does not reproduce recognisable substrings. */
const KEYSTREAM = Buffer.from('svc-docs-fake-crypto-transport-fixture-keystream-not-for-production-use')

function xor(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i++) {
    // Non-null assertions: `i` is always < buf.length by the loop bound, and
    // KEYSTREAM is a non-empty literal, so the modulo index is always in range.
    out[i] = buf[i]! ^ KEYSTREAM[i % KEYSTREAM.length]!
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * Stands in for `svc-crypto` (Task 6) — there is no live `svc-crypto` to
 * call in this environment (CONSTRAINTS: "inject all three transports and
 * test against fakes, as ... `packages/kernel/src/crypto/client.ts`
 * do[es]"). Unlike a fake that simply echoes the plaintext back
 * base64-encoded, this one reversibly obfuscates it with a fixed XOR
 * keystream — so the "stored `file_ref` is ciphertext, never a plaintext
 * MinIO path" test exercises a real property (the stored bytes do not
 * contain the plaintext pointer as a substring), the same property real
 * envelope encryption guarantees, not an artefact of the fake happening to
 * pass.
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
