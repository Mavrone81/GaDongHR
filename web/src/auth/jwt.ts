/**
 * Client-side JWT payload decode — NOT verification. This app never checks
 * a signature; every backend it talks to (via `@gadong/kernel`'s
 * `OidcMiddleware`) re-verifies the token against Keycloak's real JWKS on
 * every request, which is the actual trust boundary (see that middleware's
 * own header: "Verification, not decoding"). Decoding here is purely a UI
 * convenience — reading `sub`/`preferred_username` to know who is signed
 * in, so `proposedBy`/`approvedBy` on a statutory-rule write and the
 * segregation-of-duties nav check have a value to compare against. A
 * forged or expired token decoded here would simply be rejected by the
 * resource server on the next API call (surfaced as a 401 -> re-auth, see
 * `auth/AuthContext.tsx`), never granted anything client-side alone.
 */
export interface JwtClaims {
  sub?: string
  preferred_username?: string
  email?: string
  exp?: number
  permissions?: string[]
  [key: string]: unknown
}

function base64UrlDecode(segment: string): string {
  const padLength = (4 - (segment.length % 4)) % 4
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLength)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeJwtPayload(token: string): JwtClaims | null {
  const parts = token.split('.')
  const payloadPart = parts[1]
  if (parts.length !== 3 || !payloadPart) return null
  try {
    return JSON.parse(base64UrlDecode(payloadPart)) as JwtClaims
  } catch {
    return null
  }
}

/** Builds an unsigned, structurally-valid JWT string — used ONLY by `auth/devBypass.ts` to hand the rest of this app the same shape a real Keycloak token has. Never used on any path that reaches a real backend as proof of anything. */
export function encodeUnsignedJwt(claims: JwtClaims): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const payload = base64UrlEncode(JSON.stringify(claims))
  return `${header}.${payload}.`
}
