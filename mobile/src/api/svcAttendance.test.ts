import { createAttendanceClient } from './svcAttendance';
import type { AuthTokenSource } from './httpClient';

const tokens: AuthTokenSource = { getAccessToken: () => 't', refresh: async () => null, onUnauthorized: () => undefined };

describe('createAttendanceClient', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('punchByCode POSTs to /punches/code with the given body', async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ punch: { id: 'p1' }, duplicate: false }), { status: 200 });
    }) as typeof fetch;

    const client = createAttendanceClient('http://127.0.0.1:18006', tokens);
    const result = await client.punchByCode({ idemKey: 'k1', direction: 'in', siteCode: 'HQ', punchedAt: '2026-08-10T09:00:00.000Z', deviceId: 'mobile-app', kind: 'pin', code: '1234' });

    expect(seenUrl).toBe('http://127.0.0.1:18006/punches/code');
    expect(seenBody).toMatchObject({ idemKey: 'k1', direction: 'in', kind: 'pin' });
    expect(result.duplicate).toBe(false);
  });

  it('myPunches GETs /my/punches with from/to query params', async () => {
    let seenUrl = '';
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ punches: [] }), { status: 200 });
    }) as typeof fetch;

    const client = createAttendanceClient('http://127.0.0.1:18006', tokens);
    await client.myPunches('2026-08-01', '2026-08-31');
    expect(seenUrl).toBe('http://127.0.0.1:18006/my/punches?from=2026-08-01&to=2026-08-31');
  });
});
