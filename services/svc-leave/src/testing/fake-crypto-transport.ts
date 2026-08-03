import { randomBytes } from 'node:crypto'
import type { CryptoTransport } from '@gadong/kernel'

/**
 * Stands in for `svc-crypto` — there is no live `svc-crypto` in this
 * environment (Task brief CONSTRAINTS). Same shape and same reasoning as
 * `services/svc-docs/src/testing/fake-crypto-transport.ts`: a reversible XOR
 * obfuscation, not a plaintext echo, so "the stored `attachment_ref` is
 * ciphertext, never a plaintext pointer" exercises a real property (the
 * stored bytes do not contain the plaintext substring) rather than an
 * artefact of the fake happening to pass.
 */
const MIN_CIPHERTEXT_BYTES = 125

const KEYSTREAM = Buffer.from('svc-leave-fake-crypto-transport-fixture-keystream-not-for-production-use')

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
