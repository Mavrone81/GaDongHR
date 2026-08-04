import { randomBytes } from 'node:crypto'
import type { CryptoTransport } from '@gadong/kernel'

/**
 * Stands in for `svc-crypto` — there is no live one in this environment.
 * Same shape and reasoning as the `svc-leave`/`svc-docs` fakes: a
 * REVERSIBLE XOR OBFUSCATION, never a plaintext echo.
 *
 * That choice is load-bearing for this module above all others. The claim
 * M7 has to be able to make is "a database dump contains no salary".
 * Testing it against a fake that echoed the plaintext back would let the
 * assertion "the stored bytes do not contain '45000.00'" pass for the wrong
 * reason forever. Obfuscating means the assertion tests a real property of
 * the write path, and the `MIN_CIPHERTEXT_BYTES` padding means the kernel
 * client's own sub-floor rejection is exercised rather than bypassed.
 */
const MIN_CIPHERTEXT_BYTES = 125

const KEYSTREAM = Buffer.from('svc-payroll-fake-crypto-transport-fixture-keystream-not-for-production-use')

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
