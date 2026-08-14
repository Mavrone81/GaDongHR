import * as Crypto from 'expo-crypto';
import { bytesToBase64, toBase64Url } from '../lib/base64';

/**
 * Authorization-code + PKCE (S256), same rationale as
 * `web/src/auth/pkce.ts`'s header (the `mobile` Keycloak client is public
 * — no client secret a native app could keep — so PKCE is what stops an
 * intercepted authorization code from being redeemed by anything but this
 * app instance). Built on `expo-crypto` instead of `window.crypto`:
 * `getRandomBytesAsync`/`digestStringAsync` are Expo's own
 * CSPRNG/SHA-256, backed by the OS keychain-grade RNG on both platforms —
 * not a JS-only PRNG — so this carries the same security property web's
 * `crypto.getRandomValues`/`crypto.subtle.digest` do. Async throughout
 * (native has no synchronous CSPRNG API), unlike web's synchronous
 * `randomString`.
 */
export async function randomString(length = 64): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(length);
  return toBase64Url(bytesToBase64(bytes)).slice(0, length);
}

export async function codeChallengeFromVerifier(verifier: string): Promise<string> {
  const base64Digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return toBase64Url(base64Digest);
}
