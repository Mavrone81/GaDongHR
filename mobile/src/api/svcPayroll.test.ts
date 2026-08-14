import { createPayrollClient } from './svcPayroll';
import type { AuthTokenSource } from './httpClient';

const tokens: AuthTokenSource = { getAccessToken: () => 't', refresh: async () => null, onUnauthorized: () => undefined };

describe('createPayrollClient', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('myPayslips passes ?lang= and returns already-formatted string figures untouched', async () => {
    let seenUrl = '';
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ payslips: [{ payslipId: 'ps1', net: '฿22,986.75', gross: '฿25,000.00' }] }), { status: 200 });
    }) as typeof fetch;

    const client = createPayrollClient('http://payroll', tokens);
    const slips = await client.myPayslips('th');
    expect(seenUrl).toBe('http://payroll/my/payslips?lang=th');
    expect(slips[0]?.net).toBe('฿22,986.75');
  });
});
