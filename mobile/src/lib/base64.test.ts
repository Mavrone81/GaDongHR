import { bytesToBase64, base64ToBytes, toBase64Url, fromBase64Url } from './base64';

describe('base64', () => {
  it('round-trips arbitrary bytes through bytesToBase64 / base64ToBytes', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 16, 32, 64, 128]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('encodes a known value the same way btoa would (RFC 4648 test vector)', () => {
    const bytes = new TextEncoder().encode('any carnal pleasure.');
    expect(bytesToBase64(bytes)).toBe('YW55IGNhcm5hbCBwbGVhc3VyZS4=');
  });

  it('handles 1-byte and 2-byte remainders with correct padding', () => {
    expect(bytesToBase64(new TextEncoder().encode('a'))).toBe('YQ==');
    expect(bytesToBase64(new TextEncoder().encode('ab'))).toBe('YWI=');
    expect(bytesToBase64(new TextEncoder().encode('abc'))).toBe('YWJj');
  });

  it('toBase64Url / fromBase64Url round-trip and strip padding', () => {
    const base64 = 'YW55IGNhcm5hbCBwbGVhc3VyZS4=';
    const url = toBase64Url(base64);
    expect(url).not.toContain('=');
    expect(url).not.toContain('+');
    expect(url).not.toContain('/');
    expect(fromBase64Url(url)).toBe(base64);
  });
});
