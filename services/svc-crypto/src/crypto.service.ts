import 'reflect-metadata'
import { Inject, Injectable } from '@nestjs/common'
import { GadongError, cryptoUnavailable, isBlankPurpose } from '@gadong/kernel'
import type { EncryptRequest, FieldClass } from '@gadong/kernel'
import { seal, open, parseHeader, buildAad } from './envelope'
import { VAULT_PORT } from './vault.client'
import type { VaultPort } from './vault.client'

const BIDX_BYTES = 32

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
            const envelope = seal(
              plaintextDek,
              wrappedDek,
              f.fieldClass,
              buildAad(f.entityId, f.field),
              Buffer.from(f.value, 'utf8'),
            )
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
   *
   * `decrypt`'s wire contract (fixed by the already-merged `CryptoClient`,
   * see `packages/kernel/src/crypto/client.ts`) carries no `fieldClass` —
   * this reads it from the envelope's own header instead (Task 6 fix round
   * 1) and unwraps under exactly one KEK, always. This is the deliberate
   * replacement for an earlier "try kek-s2 then kek-s3" approach: that
   * collapsed two operationally opposite failures — a sealed Vault
   * (self-healing once officers unseal) and a ciphertext no KEK can unwrap
   * (a data-integrity alarm) — into one indistinguishable `CRY-503`, and
   * cost the hot S3 class an extra round trip on every decrypt.
   */
  async decrypt(entityId: string, field: string, ciphertextBase64: string, purpose: string): Promise<string> {
    if (isBlankPurpose(purpose)) throw purposeRequired()

    let envelope: Buffer
    let header: ReturnType<typeof parseHeader>
    try {
      envelope = Buffer.from(ciphertextBase64, 'base64')
      header = parseHeader(envelope)
    } catch (err) {
      // Data-integrity alarm, not a routine outage: an unparseable header
      // (wrong version, an unrecognised fieldClass byte, or truncation)
      // means this was never produced by this service, or was corrupted or
      // tampered with at rest. Logged distinguishably from the Vault-unwrap
      // failure below — an operator must not mistake "wake someone up" for
      // "wait for the officers to unseal." Never logs the ciphertext itself.
      console.error('svc-crypto: envelope header invalid — data-integrity alarm, not a Vault outage', err)
      throw cryptoUnavailable()
    }

    let dek: Buffer
    try {
      dek = await this.vault.unwrapDataKey(kekName(header.fieldClass), header.wrappedDek)
    } catch (err) {
      // Routine/operational: Vault sealed (the runbook pages on this after
      // 5 minutes and it self-heals once officers unseal) or unreachable.
      // Deliberately never falls back to trying another KEK — that would
      // re-introduce the ambiguity this header fix removed.
      console.error(`svc-crypto: Vault unwrap failed for ${kekName(header.fieldClass)} — sealed or unreachable`, err)
      throw cryptoUnavailable()
    }

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
