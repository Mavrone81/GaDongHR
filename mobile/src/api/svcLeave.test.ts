import { createLeaveClient } from './svcLeave';
import type { AuthTokenSource } from './httpClient';

const tokens: AuthTokenSource = { getAccessToken: () => 't', refresh: async () => null, onUnauthorized: () => undefined };

describe('createLeaveClient', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('myBalances includes ?year= only when a year is given', async () => {
    const urls: string[] = [];
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ balances: [] }), { status: 200 });
    }) as typeof fetch;

    const client = createLeaveClient('http://leave', tokens);
    await client.myBalances();
    await client.myBalances(2026);
    expect(urls).toEqual(['http://leave/my/balances', 'http://leave/my/balances?year=2026']);
  });

  it('submitRequest POSTs to /requests and unwraps { request }', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ request: { id: 'r1', status: 'pending' } }), { status: 200 })) as typeof fetch;
    const client = createLeaveClient('http://leave', tokens);
    const req = await client.submitRequest({ leaveTypeId: 'annual', startDate: '2026-09-01', endDate: '2026-09-02' });
    expect(req.id).toBe('r1');
  });

  it('cancelRequest POSTs to /requests/:id/cancel', async () => {
    let seenUrl = '';
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ id: 'r1', status: 'cancelled' }), { status: 200 });
    }) as typeof fetch;
    const client = createLeaveClient('http://leave', tokens);
    await client.cancelRequest('r1');
    expect(seenUrl).toBe('http://leave/requests/r1/cancel');
  });
});
