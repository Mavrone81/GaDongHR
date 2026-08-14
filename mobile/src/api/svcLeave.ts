import { createApiClient } from './httpClient';
import type { AuthTokenSource } from './httpClient';

/**
 * Wire types mirroring `services/svc-leave/src/leave.controller.ts` /
 * `ess-balances.service.ts` / `requests.repository.ts` — duplicated
 * deliberately, same reasoning as `web/src/api/svcConfig.ts`'s header.
 *
 * NOTE (API reality, task brief): `svc-leave` is not part of `test/e2e`'s
 * eight-service compose stack (`test/e2e/docker-compose.yml` builds
 * authz/config/crypto/onboarding/scheduler/timesheet/attendance/payroll/docs
 * only) and is not yet publicly routed by production Traefik either. This
 * client is written to the same real HTTP contract as every other service
 * client here, but — unlike attendance/timesheet/payroll — it has NOT been
 * exercised against a live `svc-leave` as part of this task's integration
 * evidence. See `.superpowers/sdd/02-modules/mobile-app.md`'s unverified list.
 */
export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type HalfDayPeriod = 'am' | 'pm';

export interface LeaveTypeRow {
  id: string;
  code: string;
  name: string;
}

export interface BalanceSummary {
  leaveTypeId: string;
  year: number;
  entitled: string;
  used: string;
  remaining: string;
}

export interface LeaveRequestRow {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  halfDayPeriod: HalfDayPeriod | null;
  days: string;
  status: LeaveRequestStatus;
  createdAt: string;
}

export interface SubmitLeaveRequestInput {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  halfDayPeriod?: HalfDayPeriod;
  hours?: string;
}

export interface LeaveClient {
  listTypes(): Promise<LeaveTypeRow[]>;
  myBalances(year?: number): Promise<BalanceSummary[]>;
  submitRequest(input: SubmitLeaveRequestInput): Promise<LeaveRequestRow>;
  cancelRequest(id: string): Promise<LeaveRequestRow>;
}

export function createLeaveClient(baseUrl: string, tokens: AuthTokenSource): LeaveClient {
  const client = createApiClient(baseUrl, tokens);
  return {
    async listTypes() {
      const res = await client.request<{ types: LeaveTypeRow[] }>('/types');
      return res.types;
    },
    async myBalances(year) {
      const query = year ? `?year=${String(year)}` : '';
      const res = await client.request<{ balances: BalanceSummary[] }>(`/my/balances${query}`);
      return res.balances;
    },
    async submitRequest(input) {
      const res = await client.request<{ request: LeaveRequestRow }>('/requests', { method: 'POST', body: JSON.stringify(input) });
      return res.request;
    },
    async cancelRequest(id) {
      return client.request<LeaveRequestRow>(`/requests/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    },
  };
}
