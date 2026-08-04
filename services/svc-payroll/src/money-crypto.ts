import { CryptoClient } from '@gadong/kernel'
import { bahtToSatang, satangToBaht } from './money'
import type { Satang } from './money'

/**
 * Every money column this service writes is envelope-encrypted BEFORE the
 * INSERT/UPDATE — `pay_profile.base_pay`, all thirteen payslip figures,
 * `pay_item.amount`, `pay_input.amount`, the bank account, the export file
 * reference. This module is the one place a `Satang` becomes ciphertext and
 * back, so there is exactly one serialisation to reason about.
 *
 * The wire form is the plain decimal baht string `satangToBaht` produces
 * ("17500.00"), not a bigint's `toString()` of satang. Two reasons: it
 * survives being read by a human during an incident, and it round-trips
 * through `bahtToSatang`, which refuses anything with sub-satang precision
 * — so a corrupted or truncated plaintext fails loudly rather than becoming
 * a plausible wrong number.
 *
 * AAD is `entityId + ':' + field` inside `svc-crypto`, which is why every
 * call here passes the ROW's id: ciphertext cannot be moved between rows or
 * between columns. Passing a run id where a payslip id belongs would make
 * the value undecryptable, which is the intended failure.
 */

/** Encrypts a whole row's money fields in ONE batch — one round trip, and `encryptBatch` rejects a duplicate field name rather than silently overwriting. */
export async function encryptMoneyFields(
  crypto: CryptoClient,
  entityId: string,
  fields: Readonly<Record<string, Satang>>,
): Promise<Map<string, Buffer>> {
  const reqs = Object.entries(fields).map(([field, amount]) => ({
    entityId,
    field,
    value: satangToBaht(amount),
    fieldClass: 'S3' as const,
  }))
  return crypto.encryptBatch(reqs)
}

/** Encrypts arbitrary S3 text (a bank account number, a MinIO object key, a serialised YTD block). */
export async function encryptTextFields(
  crypto: CryptoClient,
  entityId: string,
  fields: Readonly<Record<string, string>>,
): Promise<Map<string, Buffer>> {
  const reqs = Object.entries(fields).map(([field, value]) => ({ entityId, field, value, fieldClass: 'S3' as const }))
  return crypto.encryptBatch(reqs)
}

/**
 * `purpose` is mandatory and is what the audit trail records for this S3
 * read (Security doc §5) — the kernel client rejects a blank one before it
 * touches the transport, so there is no path here that reads a salary
 * without saying why.
 */
export async function decryptMoney(
  crypto: CryptoClient,
  entityId: string,
  field: string,
  ciphertext: Buffer,
  purpose: string,
): Promise<Satang> {
  return bahtToSatang(await crypto.decrypt(entityId, field, ciphertext, purpose))
}

export async function decryptText(
  crypto: CryptoClient,
  entityId: string,
  field: string,
  ciphertext: Buffer,
  purpose: string,
): Promise<string> {
  return crypto.decrypt(entityId, field, ciphertext, purpose)
}

/** A `bytea` as `pg` hands it back — `Buffer` in practice, `Uint8Array` under some drivers/fakes. */
export function toBuffer(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return value
  return Buffer.from(value as Uint8Array)
}
