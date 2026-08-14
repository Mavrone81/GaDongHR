jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(async (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256)),
  digestStringAsync: jest.fn(async () => 'ZGlnZXN0LWJ5dGVzLWZha2Ugc2hhMjU2LWZvci10ZXN0aW5n'),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
}));

import { randomString, codeChallengeFromVerifier } from './pkce';

describe('pkce', () => {
  it('randomString returns a string of the requested length, URL-safe (no +/=)', async () => {
    const s = await randomString(43);
    expect(s).toHaveLength(43);
    expect(s).not.toMatch(/[+/=]/);
  });

  it('randomString defaults to length 64', async () => {
    const s = await randomString();
    expect(s).toHaveLength(64);
  });

  it('codeChallengeFromVerifier base64url-encodes the digest and strips padding', async () => {
    const challenge = await codeChallengeFromVerifier('any-verifier');
    expect(challenge).not.toMatch(/[+/=]/);
    expect(challenge.length).toBeGreaterThan(0);
  });
});
