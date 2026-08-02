import { cryptoUnavailable } from '../errors'
import type { CryptoTransport, EncryptRequest, FieldClass } from './types'

export type { CryptoTransport, EncryptRequest, FieldClass } from './types'

/**
 * Ciphertext layout is `u16be(len(wrappedDEK)) ‖ wrappedDEK ‖ nonce(12) ‖ ct ‖ tag(16)`
 * (AES-256-GCM), per the roadmap's data-classification contract (revised 2026-08-02,
 * Task 3 review — supersedes the earlier prefix-less `wrappedDEK ‖ nonce ‖ ct ‖ tag`,
 * which had no delimiter and so could only be checked on total length). The 2-byte
 * big-endian length prefix is what lets a reader find where `wrappedDEK` ends at all.
 *
 * `svc-crypto` (Task 6) wraps each 32-byte DEK with Vault Transit's `datakey/plaintext`
 * operation, whose ciphertext is the string `vault:v1:` + base64(version(1) ‖ nonce(12)
 * ‖ ct(32) ‖ tag(16)) — 9 + base64(61 bytes) = 9 + 84 = 93 ASCII bytes. That 93-byte
 * figure is pinned by `services/svc-crypto/src/vault.client.test.ts`
 * ("pins the wrappedDek byte length from a realistic Vault response"), not by memory,
 * per Task 6 brief §4. So the true floor is:
 *
 *   2 (length prefix) + 93 (wrappedDEK) + 12 (nonce) + 0 (empty ct) + 16 (tag) = 123
 *
 * Anything shorter — including an empty string — cannot be genuine ciphertext under
 * this wrap format, so it must never be written to a `bytea` column believing it is.
 * Kernel and `svc-crypto` must move this floor together: a mismatch means one side
 * writes envelopes the other rejects (roadmap "Contracts every phase depends on").
 */
const MIN_CIPHERTEXT_BYTES = 123

/**
 * A blind index is `HMAC-SHA256(k_class, normalise(plaintext))`, which is invariantly
 * exactly 32 bytes — not a minimum, a fixed length. Anything shorter is not a real HMAC
 * output and would let unrelated rows collide on a truncated/empty index; anything longer
 * is equally not a real HMAC output and would still be a knowingly-malformed value written
 * into a `<field>_bidx` column, even though an over-long value can't collide with a real one.
 */
const BIDX_BYTES = 32

/**
 * Zero-width characters that survive `String.prototype.trim()` (which only strips
 * whitespace/line-terminator code points) but render as blank: ZWSP, ZWNJ, ZWJ, BOM.
 */
const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isEncryptResponse(v: unknown): v is { fields: Record<string, unknown> } {
  return isRecord(v) && isRecord(v['fields'])
}

function isDecryptResponse(v: unknown): v is { value: string } {
  return isRecord(v) && typeof v['value'] === 'string'
}

function isBidxResponse(v: unknown): v is { bidx: string } {
  return isRecord(v) && typeof v['bidx'] === 'string'
}

/**
 * True when a purpose is empty once both ordinary whitespace and zero-width characters are
 * stripped. Exported because it is the one definition of "blank purpose" for every mandatory-
 * purpose check in the kernel (also used by `AuditEmitter.emit` for `.sensitive.read` actions) —
 * a PDPA requirement must not have two divergent definitions of what counts as satisfying it.
 */
export function isBlankPurpose(purpose: string): boolean {
  return purpose.trim().replace(ZERO_WIDTH_CHARS, '').length === 0
}

/**
 * Client for svc-crypto (Task 6). Every S2/S3 field in every service passes through
 * this class, which is why every path below fails closed: a transport rejection, a
 * malformed response, a response missing a requested field, or a response whose
 * decoded payload is too short to be real ciphertext/HMAC output all surface as the
 * same `cryptoUnavailable()` (CRY-503) — never a raw network error, never a partial
 * or corrupt result, and never plaintext written believing it was encrypted.
 */
export class CryptoClient {
  constructor(private readonly transport: CryptoTransport) {}

  /** NFKC-fold, then trim, then lowercase — in that order, so full-width variants fold consistently. */
  normalise(value: string): string {
    return value.normalize('NFKC').trim().toLowerCase()
  }

  async encryptBatch(reqs: EncryptRequest[]): Promise<Map<string, Buffer>> {
    // Nothing to ask svc-crypto — return without a pointless round-trip.
    if (reqs.length === 0) return new Map()

    // The response is keyed by field name (Map<field, Buffer>), so a batch that asks
    // for the same field twice — e.g. two different entities' national_id — cannot be
    // answered unambiguously: the second ciphertext would silently overwrite the
    // first, and a caller could bind one employee's AAD-bound ciphertext to another's
    // row. Reject the request rather than answer it wrongly.
    const seenFields = new Set<string>()
    for (const req of reqs) {
      if (seenFields.has(req.field)) {
        throw new Error(`encryptBatch: duplicate field "${req.field}" in one batch is not answerable — the result can only be keyed by field name`)
      }
      seenFields.add(req.field)
    }

    let response: unknown
    try {
      response = await this.transport.post('/encrypt', { fields: reqs })
    } catch {
      // Fail closed: any transport rejection (network error, timeout, sealed Vault
      // relayed as an error) becomes CRY-503, never a raw error the caller might
      // mishandle as "skip and continue".
      throw cryptoUnavailable()
    }

    if (!isEncryptResponse(response)) throw cryptoUnavailable()

    const out = new Map<string, Buffer>()
    for (const req of reqs) {
      const encoded = response.fields[req.field]
      // No partial results: a response missing even one requested field throws
      // rather than returning a map the caller could partially trust — that gap
      // is exactly how a plaintext column would get written believing it was
      // encrypted.
      if (typeof encoded !== 'string') throw cryptoUnavailable()

      const buf = Buffer.from(encoded, 'base64')
      // A too-short decode (e.g. "" decoding to 0 bytes, or svc-crypto echoing
      // plaintext back) cannot be genuine ciphertext per the fixed wire layout —
      // treat it as a crypto failure, not a value to hand the caller.
      if (buf.length < MIN_CIPHERTEXT_BYTES) throw cryptoUnavailable()

      out.set(req.field, buf)
    }
    return out
  }

  async decrypt(entityId: string, field: string, ciphertext: Buffer, purpose: string): Promise<string> {
    // Validated before the transport is touched: purpose is what the audit trail
    // records for this S3 read (Security doc §5), so an empty — or blank-looking —
    // purpose must never fall through to a default.
    if (isBlankPurpose(purpose)) throw new Error('purpose is required')

    // The client refuses to *produce* sub-floor ciphertext (see encryptBatch), so a
    // sub-floor ciphertext arriving here means the stored column is corrupt — that is
    // a crypto failure, not a caller bug, so it fails closed the same as any other
    // crypto failure rather than being sent to the service.
    if (ciphertext.length < MIN_CIPHERTEXT_BYTES) throw cryptoUnavailable()

    const body = {
      entityId,
      field,
      ciphertext: ciphertext.toString('base64'),
      purpose: purpose.trim(),
    }

    let response: unknown
    try {
      response = await this.transport.post('/decrypt', body)
    } catch {
      throw cryptoUnavailable()
    }

    if (!isDecryptResponse(response)) throw cryptoUnavailable()
    return response.value
  }

  async blindIndex(fieldClass: FieldClass, field: string, value: string): Promise<Buffer> {
    const body = { fieldClass, field, value: this.normalise(value) }

    let response: unknown
    try {
      response = await this.transport.post('/bidx', body)
    } catch {
      throw cryptoUnavailable()
    }

    if (!isBidxResponse(response)) throw cryptoUnavailable()

    const buf = Buffer.from(response.bidx, 'base64')
    // HMAC-SHA256 output is exactly 32 bytes, always — so this is an equality check,
    // not a floor. Too short lets unrelated rows collide on a truncated/empty index;
    // too long can't collide with a real bidx, but is still a malformed value we must
    // not write to a `<field>_bidx` column.
    if (buf.length !== BIDX_BYTES) throw cryptoUnavailable()

    return buf
  }
}
