import { createTimesheetClient } from './svcTimesheet';
import type { AuthTokenSource } from './httpClient';

const tokens: AuthTokenSource = { getAccessToken: () => 't', refresh: async () => null, onUnauthorized: () => undefined };

describe('createTimesheetClient', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('myDays unwraps { days } and passes through OT fields untouched', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ days: [{ id: 'd1', ot15x: '2.00', ot2x: '0.00', ot3x: '0.00' }] }), { status: 200 })) as typeof fetch;
    const client = createTimesheetClient('http://127.0.0.1:18007', tokens);
    const days = await client.myDays('2026-08-01', '2026-08-31');
    expect(days).toHaveLength(1);
    expect(days[0]?.ot15x).toBe('2.00');
  });

  it('listPeriods unwraps { periods }', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ periods: [{ id: 'p1', status: 'locked' }] }), { status: 200 })) as typeof fetch;
    const client = createTimesheetClient('http://127.0.0.1:18007', tokens);
    const periods = await client.listPeriods();
    expect(periods[0]?.status).toBe('locked');
  });
});
