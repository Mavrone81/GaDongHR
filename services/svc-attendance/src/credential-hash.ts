import { createHmac } from 'node:crypto'

/**
 * PIN/QR/badge credential hashing for M4-5 (PDPA-BIOMETRIC-COMPLIANCE.md
 * §4.2: alternative-method credentials are stored hashed, never plaintext —
 * "hashed storage" per the module doc's API manual row 4). This is a keyed
 * HMAC-SHA256, not `svc-crypto` envelope encryption: a PIN/QR/badge code is
 * not itself PDPA sensitive personal data the way a face template or
 * national ID is, but it IS a credential, so it gets the same treatment any
 * password-shaped secret gets — verified by re-hashing and comparing, never
 * decrypted back to plaintext (there is no decrypt direction at all).
 *
 * The employee id is folded into the hashed material (`${employeeId}:${kind}:${code}`),
 * not just `${kind}:${code}` — this is what lets two different employees
 * independently choose the same PIN without colliding against
 * `alternative_credential_hash_key UNIQUE` (see the phase-3 migration's file
 * header). QR/badge codes are still effectively globally unique in
 * practice (they are scanned, not typed, so nobody "chooses" one to
 * collide with another employee's), so folding the employee id in for
 * those too is harmless — it does not weaken the UNIQUE constraint's real
 * job of catching an accidental duplicate badge assignment, since the
 * lookup path (`findByHash`) always re-derives the same hash from the
 * scanned code AND the specific employee context is not known at scan
 * time... except it does not need to be: `hashPin` (verify path for PIN,
 * where the employee is already known) and `hashLookupCode` (verify path
 * for QR/badge, where only the scanned code is known) are two distinct
 * functions below specifically so the two flows never need the same
 * hashing shape.
 */
const HMAC_ALGO = 'sha256'

/** PIN hash — scoped to one employee, so two employees may share a PIN without a UNIQUE-constraint collision. Used both to store (`enrolAlternative`) and to verify (`/punches/code` with `kind: 'pin'`, where `employeeId` is already known). */
export function hashPin(pepper: string, employeeId: string, pin: string): Buffer {
  return createHmac(HMAC_ALGO, pepper).update(`pin:${employeeId}:${pin}`).digest()
}

/** QR/badge hash — NOT scoped to an employee: the whole point is that scanning the code alone must resolve to exactly one employee (`AlternativeCredentialRepository.findByHash`), which is what `alternative_credential_hash_key UNIQUE` enforces. */
export function hashLookupCode(pepper: string, kind: 'qr' | 'badge', code: string): Buffer {
  return createHmac(HMAC_ALGO, pepper).update(`${kind}:${code}`).digest()
}
