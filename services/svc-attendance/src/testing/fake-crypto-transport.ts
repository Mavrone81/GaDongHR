import { randomBytes, createHmac } from 'node:crypto'
import type { CryptoTransport } from '@gadong/kernel'

/**
 * Mirrors `services/svc-onboarding/src/testing/fake-crypto-transport.ts`
 * (and `svc-docs`'s) almost exactly — same reasoning: `svc-crypto` is not
 * built in this environment, so every S2/S3 write/read in this service
 * (here: `device.device_secret`) is proven against this fake rather than a
 * network call. Reversible XOR-with-fixed-keystream "encryption" — enough
 * to prove "the stored bytea does not contain the plaintext as a
 * substring" is a real property, not an artefact of the fake.
 */
const MIN_CIPHERTEXT_BYTES = 125
const KEYSTREAM = Buffer.from('svc-attendance-fake-crypto-transport-fixture-keystream-not-for-production')
const BIDX_KEY = 'svc-attendance-fake-bidx-key-not-for-production'

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

      if (path === '/bidx') {
        if (!isRecord(body) || typeof body['value'] !== 'string') throw new Error('fakeCryptoTransport: malformed /bidx body')
        const bidx = createHmac('sha256', BIDX_KEY).update(body['value']).digest()
        return { bidx: bidx.toString('base64') }
      }

      throw new Error(`fakeCryptoTransport: unexpected path ${path}`)
    },
  }
}

/** A transport whose every call rejects — for proving CRY-503 fail-closed behaviour. */
export function unavailableCryptoTransport(): CryptoTransport {
  return {
    post(): Promise<unknown> {
      return Promise.reject(new Error('svc-crypto unreachable (fixture)'))
    },
  }
}
