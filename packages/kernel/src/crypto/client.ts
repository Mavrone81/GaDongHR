import { cryptoUnavailable } from '../errors'
import type { CryptoTransport, EncryptRequest, FieldClass } from './types'

export type { CryptoTransport, EncryptRequest, FieldClass } from './types'

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
 * Client for svc-crypto (Task 6). Every S2/S3 field in every service passes through
 * this class, which is why every path below fails closed: a transport rejection,
 * a malformed response, or a response missing a requested field all surface as the
 * same `cryptoUnavailable()` (CRY-503) — never a raw network error, never a partial
 * result, and never plaintext written believing it was encrypted.
 */
export class CryptoClient {
  constructor(private readonly transport: CryptoTransport) {}

  /** NFKC-fold, then trim, then lowercase — in that order, so full-width variants fold consistently. */
  normalise(value: string): string {
    return value.normalize('NFKC').trim().toLowerCase()
  }

  async encryptBatch(reqs: EncryptRequest[]): Promise<Map<string, Buffer>> {
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
      out.set(req.field, Buffer.from(encoded, 'base64'))
    }
    return out
  }

  async decrypt(entityId: string, field: string, ciphertext: Buffer, purpose: string): Promise<string> {
    // Validated before the transport is touched: purpose is what the audit trail
    // records for this S3 read (Security doc §5), so an empty purpose must never
    // fall through to a default.
    if (!purpose.trim()) throw new Error('purpose is required')

    let response: unknown
    try {
      response = await this.transport.post('/decrypt', {
        entityId,
        field,
        ciphertext: ciphertext.toString('base64'),
        purpose,
      })
    } catch {
      throw cryptoUnavailable()
    }

    if (!isDecryptResponse(response)) throw cryptoUnavailable()
    return response.value
  }

  async blindIndex(fieldClass: FieldClass, field: string, value: string): Promise<Buffer> {
    let response: unknown
    try {
      response = await this.transport.post('/bidx', {
        fieldClass,
        field,
        value: this.normalise(value),
      })
    } catch {
      throw cryptoUnavailable()
    }

    if (!isBidxResponse(response)) throw cryptoUnavailable()
    return Buffer.from(response.bidx, 'base64')
  }
}
