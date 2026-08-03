/**
 * Authorization-code + PKCE (S256) against the `web` Keycloak client —
 * `deploy/keycloak/realm-gadonghr.json`'s `web` client is public
 * (`publicClient: true`), so PKCE (not a client secret, which a public
 * client cannot keep) is what stops an intercepted authorization code from
 * being redeemed by anyone but this browser tab. `pkce.code.challenge.method:
 * "S256"` on that client means Keycloak REJECTS a plain-method or missing
 * challenge outright — this module has no fallback path that omits it.
 */
function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomString(length = 64): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return base64UrlFromBytes(bytes).slice(0, length)
}

export async function codeChallengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlFromBytes(new Uint8Array(digest))
}
