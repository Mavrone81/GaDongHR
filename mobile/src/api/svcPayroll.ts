import { createApiClient } from './httpClient';
import type { AuthTokenSource } from './httpClient';

/**
 * Wire type mirroring `services/svc-payroll/src/payslips.service.ts`'s
 * `PayslipSummary` — duplicated deliberately, same reasoning as
 * `web/src/api/svcConfig.ts`'s header. Every money/date figure here
 * arrives ALREADY FORMATTED by the server (`payslips.service.ts`'s own
 * doc: "formatting is the last step and happens once" — `formatTHB`/
 * `formatDate` run server-side before this response is built), so this
 * app renders `gross`/`net`/etc. as plain strings and does NOT re-run
 * `lib/i18n/format.ts` over them — re-formatting an already-formatted
 * string would be the exact "second implementation" DESIGN.md forbids.
 */
export interface PayslipLine {
  kind: string;
  amount: string;
}

export interface PayslipSummary {
  payslipId: string;
  runId: string;
  employeeId: string;
  period: string;
  lang: 'th' | 'en' | 'zh';
  payDate: string | null;
  gross: string;
  taxableGross: string;
  nonTaxablePay: string;
  ssoEmployee: string;
  ssoEmployer: string;
  ewfEmployee: string;
  ewfEmployer: string;
  pfEmployee: string;
  pfEmployer: string;
  wht: string;
  net: string;
  /** MinIO object key of the rendered PDF — `svc-docs` render/download, not fetched by this client directly (task brief: "PDF via svc-docs render where available"). */
  pdfRef: string;
  lines: PayslipLine[];
}

export interface PayrollClient {
  myPayslips(lang?: 'th' | 'en' | 'zh'): Promise<PayslipSummary[]>;
}

export function createPayrollClient(baseUrl: string, tokens: AuthTokenSource): PayrollClient {
  const client = createApiClient(baseUrl, tokens);
  return {
    async myPayslips(lang) {
      const query = lang ? `?lang=${lang}` : '';
      const res = await client.request<{ payslips: PayslipSummary[] }>(`/my/payslips${query}`);
      return res.payslips;
    },
  };
}
