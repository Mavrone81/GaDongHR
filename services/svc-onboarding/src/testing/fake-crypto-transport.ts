import { randomBytes } from 'node:crypto'
import { createHmac } from 'node:crypto'
import type { CryptoTransport } from '@gadong/kernel'

/**
 * `CryptoClient`'s (kernel) floor for what counts as plausible ciphertext —
 * duplicated here rather than imported (same reasoning as
 * `services/svc-docs/src/testing/fake-crypto-transport.ts`, which this file
 * mirrors almost exactly): this fake deliberately does not depend on
 * `svc-crypto`'s real envelope format, only on producing something the same
 * LENGTH a real envelope would be.
 */
const MIN_CIPHERTEXT_BYTES = 125

/** Fixed, non-secret keystream — test fixture only, not a security boundary. */
const KEYSTREAM = Buffer.from('svc-onboarding-fake-crypto-transport-fixture-keystream-not-for-production')

/** Fixed, non-secret HMAC key for the fake blind index — a real deployment's key lives in Vault (svc-crypto), never here. */
const BIDX_KEY = 'svc-onboarding-fake-bidx-key-not-for-production'

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
 * Stands in for `svc-crypto` (not built in this environment — task
 * CONSTRAINTS: "no Postgres here — test against a fake as `services/
 * svc-config` does"; the same applies to `svc-crypto`, which every sibling
 * service's tests fake rather than call over HTTP). Reversibly obfuscates
 * plaintext with a fixed XOR keystream rather than merely base64-echoing it
 * back, so "the stored bytea does not contain the plaintext as a substring"
 * exercises a real property, not an artefact of the fake happening to pass —
 * same design as `svc-docs`'s fake.
 *
 * `/bidx` is a real (test-only-keyed) HMAC-SHA256, so two calls with the
 * same normalised value always collide (proving ONB-002's duplicate
 * detection) and two different values (almost) never do.
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

      if (path === '/bidx') {
        if (!isRecord(body) || typeof body['value'] !== 'string') throw new Error('fakeCryptoTransport: malformed /bidx body')
        const bidx = createHmac('sha256', BIDX_KEY).update(body['value']).digest()
        return { bidx: bidx.toString('base64') }
      }

      throw new Error(`fakeCryptoTransport: unexpected path ${path}`)
    },
  }
}

/** A transport whose every call rejects — for proving CRY-503 fail-closed behaviour (Vault sealed / svc-crypto unreachable). */
export function unavailableCryptoTransport(): CryptoTransport {
  return {
    post(): Promise<unknown> {
      return Promise.reject(new Error('svc-crypto unreachable (fixture)'))
    },
  }
}
