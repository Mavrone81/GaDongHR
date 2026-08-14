process.env['EXPO_PUBLIC_OIDC_ISSUER'] = 'http://issuer';
process.env['EXPO_PUBLIC_SVC_I18N_URL'] = 'http://127.0.0.1:9999';

import { fetchBundle } from './svcI18n';

describe('fetchBundle', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the flat bundle on a valid response', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ 'shell.brand': 'GaDongHR' }), { status: 200 })) as typeof fetch;
    const bundle = await fetchBundle('en');
    expect(bundle).toEqual({ 'shell.brand': 'GaDongHR' });
  });

  it('throws on a non-flat (still-nested) shape rather than silently degrading', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ shell: { brand: 'GaDongHR' } }), { status: 200 })) as typeof fetch;
    await expect(fetchBundle('en')).rejects.toThrow(/unusable bundle shape/);
  });

  it('is unauthenticated — sends no Authorization header', async () => {
    let seenAuth: string | null = 'unset';
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get('Authorization');
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    await fetchBundle('th');
    expect(seenAuth).toBeNull();
  });
});
