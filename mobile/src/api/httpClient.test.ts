import { createApiClient, ApiError } from './httpClient';
import type { AuthTokenSource } from './httpClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createApiClient', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('builds the request URL by joining baseUrl and path, trimming duplicate slashes', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const client = createApiClient('http://localhost:3000/', null);
    await client.request('/my/days');
    expect(calls).toEqual(['http://localhost:3000/my/days']);
  });

  it('attaches a bearer token from the token source when present', async () => {
    let seenAuth: string | null = null;
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get('Authorization');
      return jsonResponse(200, {});
    }) as typeof fetch;

    const tokens: AuthTokenSource = { getAccessToken: () => 'tok-123', refresh: async () => null, onUnauthorized: () => undefined };
    const client = createApiClient('http://localhost:3000', tokens);
    await client.request('/x');
    expect(seenAuth).toBe('Bearer tok-123');
  });

  it('on a 401, retries once with a refreshed token, then succeeds', async () => {
    let call = 0;
    const seenTokens: Array<string | null> = [];
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      seenTokens.push(new Headers(init?.headers).get('Authorization'));
      return call === 1 ? jsonResponse(401, { code: 'X', message_i18n_key: 'x', details: [] }) : jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const tokens: AuthTokenSource = { getAccessToken: () => 'stale', refresh: async () => 'fresh', onUnauthorized: jest.fn() };
    const client = createApiClient('http://localhost:3000', tokens);
    const result = await client.request<{ ok: boolean }>('/x');
    expect(result).toEqual({ ok: true });
    expect(seenTokens).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('calls onUnauthorized and throws ApiError(401) when the retry also 401s', async () => {
    global.fetch = jest.fn(async () => jsonResponse(401, { code: 'AUTH-401', message_i18n_key: 'auth.error', details: [] })) as typeof fetch;
    const onUnauthorized = jest.fn();
    const tokens: AuthTokenSource = { getAccessToken: () => 'a', refresh: async () => 'b', onUnauthorized };
    const client = createApiClient('http://localhost:3000', tokens);

    await expect(client.request('/x')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError with the parsed envelope on a non-401 error', async () => {
    global.fetch = jest.fn(async () => jsonResponse(422, { code: 'LVE-030', message_i18n_key: 'leave.error.floor', details: [{ a: 1 }] })) as typeof fetch;
    const client = createApiClient('http://localhost:3000', null);

    try {
      await client.request('/x');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect((err as ApiError).envelope?.code).toBe('LVE-030');
    }
  });

  it('returns undefined for a 204 response without parsing a body', async () => {
    global.fetch = jest.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    const client = createApiClient('http://localhost:3000', null);
    await expect(client.request('/x')).resolves.toBeUndefined();
  });
});
