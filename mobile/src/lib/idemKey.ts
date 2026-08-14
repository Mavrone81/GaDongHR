import * as Crypto from 'expo-crypto';

/** A short, unique-enough idempotency key for a punch/write request — `Crypto.randomUUID()` (Expo's own CSPRNG-backed UUID, synchronous) prefixed with a millisecond timestamp for easy log correlation, mirroring the shape `test/e2e/lifecycle.e2e.test.ts` uses (`e2e-${Date.now().toString(36)}-in`). */
export function newIdemKey(suffix: string): string {
  return `mobile-${Date.now().toString(36)}-${Crypto.randomUUID()}-${suffix}`;
}
