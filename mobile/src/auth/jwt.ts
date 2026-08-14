import { base64ToBytes, fromBase64Url } from '../lib/base64';

/**
 * Client-side JWT payload decode — NOT verification. Ported from
 * `web/src/auth/jwt.ts`; read that file's header for the full rationale
 * (every backend re-verifies the signature against Keycloak's real JWKS on
 * every request — decoding here is a UI convenience only, never a trust
 * boundary).
 */
export interface JwtClaims {
  sub?: string;
  preferred_username?: string;
  email?: string;
  exp?: number;
  permissions?: string[];
  [key: string]: unknown;
}

function base64UrlDecode(segment: string): string {
  const bytes = base64ToBytes(fromBase64Url(segment));
  return new TextDecoder('utf-8').decode(bytes);
}

export function decodeJwtPayload(token: string): JwtClaims | null {
  const parts = token.split('.');
  const payloadPart = parts[1];
  if (parts.length !== 3 || !payloadPart) return null;
  try {
    return JSON.parse(base64UrlDecode(payloadPart)) as JwtClaims;
  } catch {
    return null;
  }
}
