import 'reflect-metadata'
import { Inject, Injectable } from '@nestjs/common'
import { GadongError, cryptoUnavailable, isBlankPurpose } from '@gadong/kernel'
import type { EncryptRequest, FieldClass } from '@gadong/kernel'
import { seal, open, peekWrappedDek, buildAad } from './envelope'
import { VAULT_PORT } from './vault.client'
import type { VaultPort } from './vault.client'

const BIDX_BYTES = 32

/**
 * `decrypt`'s wire contract (fixed by the already-merged `CryptoClient`,
 * see `packages/kernel/src/crypto/client.ts`) is `{entityId, field,
 * ciphertext, purpose}` — it carries no `fieldClass`, so this service
 * cannot look up a single KEK name for an unwrap the way `encryptBatch`
 * can. The only two field classes that exist (`FieldClass` = `'S2'|'S3'`)
 * make trying each of `kek-s2`/`kek-s3` in turn a small, bounded, and safe
 * way to close that gap: Vault Transit's `decrypt` operation is scoped to
 * one named key and simply errors on a ciphertext it doesn't own, so
 * attempting the wrong key first leaks nothing and costs one extra round
 * trip in the worst case.
 */
const FIELD_CLASSES: readonly FieldClass[] = ['S2', 'S3']

function kekName(fieldClass: FieldClass): string {
  return `kek-${fieldClass.toLowerCase()}`
}

function purposeRequired(): GadongError {
  return new GadongError('CRY-400', 'crypto.error.purpose_required', 400)
}

/**
 * Business logic behind `/encrypt`, `/decrypt`, `/bidx` and the `vault`
 * half of `/health`. Every path here fails closed: any Vault failure —
 * sealed, unreachable, or a malformed response — becomes `cryptoUnavailable()`
 * (`CRY-503`), never a raw error, never a partial result, and never
 * plaintext returned, logged, or otherwise persisted (Task 6 brief,
 * "Carried forward (binding)").
 */
@Injectable()
export class CryptoService {
  constructor(@Inject(VAULT_PORT) private readonly vault: VaultPort) {}

  /**
   * Seals every field in the batch. If any single field's Vault call
   * fails, the whole batch fails — there is no code path that returns an
   * object with some fields present and others missing, because that gap
   * is exactly how a caller could end up writing one column in plaintext
   * while believing every column in the batch was encrypted.
   */
  async encryptBatch(fields: readonly EncryptRequest[]): Promise<Record<string, string>> {
    if (fields.length === 0) return {}

    let sealed: readonly [string, Buffer][]
    try {
      sealed = await Promise.all(
        fields.map(async (f): Promise<[string, Buffer]> => {
          const { plaintextDek, wrappedDek } = await this.vault.generateDataKey(kekName(f.fieldClass))
          try {
            const envelope = seal(plaintextDek, wrappedDek, buildAad(f.entityId, f.field), Buffer.from(f.value, 'utf8'))
            return [f.field, envelope]
          } finally {
            // Best-effort scrub: this plaintext DEK must not linger in memory
            // any longer than the one `seal()` call that needed it.
            plaintextDek.fill(0)
          }
        }),
      )
    } catch {
      throw cryptoUnavailable()
    }

    const out: Record<string, string> = {}
    for (const [field, envelope] of sealed) out[field] = envelope.toString('base64')
    return out
  }

  /**
   * Purpose is validated — and rejected — before any Vault call, per the
   * brief: an empty audit `purpose` must never be masked by a Vault
   * round-trip that then fails for an unrelated reason.
   */
  async decrypt(entityId: string, field: string, ciphertextBase64: string, purpose: string): Promise<string> {
    if (isBlankPurpose(purpose)) throw purposeRequired()

    let envelope: Buffer
    let wrappedDek: Buffer
    try {
      envelope = Buffer.from(ciphertextBase64, 'base64')
      wrappedDek = peekWrappedDek(envelope)
    } catch {
      // Malformed/truncated ciphertext can never be genuine — fail closed
      // the same as any other crypto failure, not a raw parse error.
      throw cryptoUnavailable()
    }

    const dek = await this.unwrapUnderAnyClass(wrappedDek)

    try {
      const plaintext = open(dek, buildAad(entityId, field), envelope)
      return plaintext.toString('utf8')
    } catch {
      // Covers tamper detection AND AAD binding: a ciphertext swapped
      // between rows/fields, or between entities, fails here and only
      // here throws — never a partial or garbage plaintext.
      throw cryptoUnavailable()
    } finally {
      dek.fill(0)
    }
  }

  private async unwrapUnderAnyClass(wrappedDek: Buffer): Promise<Buffer> {
    for (const fieldClass of FIELD_CLASSES) {
      try {
        return await this.vault.unwrapDataKey(kekName(fieldClass), wrappedDek)
      } catch {
        // Try the next class — Vault Transit scopes `decrypt` to one named
        // key and simply errors on a ciphertext it doesn't own.
      }
    }
    throw cryptoUnavailable()
  }

  /**
   * `HMAC-SHA256(k_class, normalise(plaintext))`. `value` arrives already
   * normalised — `CryptoClient.blindIndex` normalises before this service
   * ever sees it (roadmap "Data classification" contract) — so this never
   * re-normalises, which would be a second, potentially divergent,
   * definition of "normalised" living in two services.
   */
  async bidx(fieldClass: FieldClass, field: string, value: string): Promise<string> {
    void field // part of the wire contract; the HMAC key is scoped by fieldClass only
    let mac: Buffer
    try {
      mac = await this.vault.hmac(kekName(fieldClass), Buffer.from(value, 'utf8'))
    } catch {
      throw cryptoUnavailable()
    }
    if (mac.length !== BIDX_BYTES) throw cryptoUnavailable()
    return mac.toString('base64')
  }

  /** `up` only when Vault is reachable and unsealed; `down` — never a throw — otherwise. */
  async health(): Promise<'up' | 'down'> {
    try {
      return await this.vault.health()
    } catch {
      return 'down'
    }
  }
}
