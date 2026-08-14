import { decodeJwtPayload } from './jwt';
import { bytesToBase64, toBase64Url } from '../lib/base64';

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) => toBase64Url(bytesToBase64(new TextEncoder().encode(JSON.stringify(obj))));
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

describe('decodeJwtPayload', () => {
  it('decodes a well-formed unsigned JWT payload', () => {
    const token = fakeJwt({ sub: 'user-1', preferred_username: 'somchai', permissions: ['leave.request'] });
    expect(decodeJwtPayload(token)).toEqual({ sub: 'user-1', preferred_username: 'somchai', permissions: ['leave.request'] });
  });

  it('decodes non-ASCII (Thai) claim values correctly (UTF-8 through the base64url path)', () => {
    const token = fakeJwt({ preferred_username: 'สมชาย' });
    expect(decodeJwtPayload(token)?.preferred_username).toBe('สมชาย');
  });

  it('returns null for a token with the wrong number of segments', () => {
    expect(decodeJwtPayload('only.two')).toBeNull();
    expect(decodeJwtPayload('one')).toBeNull();
  });

  it('returns null for a payload segment that is not valid JSON', () => {
    expect(decodeJwtPayload('a.bm90LWpzb24.c')).toBeNull();
  });
});
