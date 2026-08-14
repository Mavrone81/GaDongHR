import { buildAuthorizeUrl, exchangeCodeForTokens, refreshTokenSet, logoutEndpoint } from './oidcClient';
import type { OidcConfig } from './oidcClient';

const config: OidcConfig = { issuer: 'http://127.0.0.1:18081', clientId: 'mobile', redirectUri: 'gadonghr://auth/callback' };

describe('oidcClient', () => {
  it('buildAuthorizeUrl includes PKCE S256 params and the exact redirect_uri', () => {
    const url = buildAuthorizeUrl(config, 'state-1', 'challenge-1');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('http://127.0.0.1:18081/protocol/openid-connect/auth');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('mobile');
    expect(parsed.searchParams.get('redirect_uri')).toBe('gadonghr://auth/callback');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('state')).toBe('state-1');
  });

  it('logoutEndpoint strips trailing slashes from the issuer', () => {
    expect(logoutEndpoint('http://issuer//')).toBe('http://issuer/protocol/openid-connect/logout');
  });

  describe('exchangeCodeForTokens', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('posts the authorization_code grant and returns a TokenSet', async () => {
      let seenBody = '';
      global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        seenBody = String(init?.body);
        return new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', id_token: 'IT', expires_in: 300, token_type: 'Bearer' }), { status: 200 });
      }) as typeof fetch;

      const tokens = await exchangeCodeForTokens(config, 'code-1', 'verifier-1', () => 1_000_000);
      expect(tokens).toEqual({ accessToken: 'AT', refreshToken: 'RT', idToken: 'IT', expiresAt: 1_000_000 + 300_000 });
      expect(seenBody).toContain('grant_type=authorization_code');
      expect(seenBody).toContain('code_verifier=verifier-1');
    });

    it('throws on a non-ok response', async () => {
      global.fetch = jest.fn(async () => new Response('nope', { status: 400 })) as typeof fetch;
      await expect(exchangeCodeForTokens(config, 'c', 'v')).rejects.toThrow(/token exchange failed/);
    });

    it('throws on a malformed token response', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch;
      await expect(exchangeCodeForTokens(config, 'c', 'v')).rejects.toThrow(/malformed token response/);
    });
  });

  describe('refreshTokenSet', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns a TokenSet on success', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ access_token: 'AT2', expires_in: 60, token_type: 'Bearer' }), { status: 200 })) as typeof fetch;
      const tokens = await refreshTokenSet(config, 'RT', () => 0);
      expect(tokens).toEqual({ accessToken: 'AT2', refreshToken: null, idToken: null, expiresAt: 60_000 });
    });

    it('returns null (never throws) on a non-ok response', async () => {
      global.fetch = jest.fn(async () => new Response('nope', { status: 400 })) as typeof fetch;
      await expect(refreshTokenSet(config, 'RT')).resolves.toBeNull();
    });

    it('returns null on a network failure', async () => {
      global.fetch = jest.fn(async () => {
        throw new Error('network down');
      }) as typeof fetch;
      await expect(refreshTokenSet(config, 'RT')).resolves.toBeNull();
    });
  });
});
