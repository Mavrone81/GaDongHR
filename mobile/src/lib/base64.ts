/**
 * Dependency-free base64 / base64url encode-decode, used by `auth/jwt.ts`
 * and `auth/pkce.ts`. Deliberately NOT built on the DOM `atob`/`btoa`
 * globals `web/src/auth/jwt.ts` and `pkce.ts` use — Hermes (React Native's
 * JS engine) does not guarantee those globally the way a browser does, and
 * this module also needs to run unmodified under plain Node (Jest,
 * `scripts/integration-check.ts`), so one small self-contained
 * implementation covers all three runtimes with no platform branching.
 */
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    result += CHARS[b0 >> 2];
    result += CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)];
    result += CHARS[b2 & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i] ?? 0;
    result += CHARS[b0 >> 2];
    result += CHARS[(b0 & 0x03) << 4];
    result += '==';
  } else if (remaining === 2) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    result += CHARS[b0 >> 2];
    result += CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += CHARS[(b1 & 0x0f) << 2];
    result += '=';
  }
  return result;
}

export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = CHARS.indexOf(ch);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(base64url: string): string {
  const padLength = (4 - (base64url.length % 4)) % 4;
  return base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLength);
}
