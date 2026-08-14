import { createApiClient } from './httpClient';
import type { AuthTokenSource } from './httpClient';

/** Wire types mirroring `services/svc-timesheet/src/day-record.repository.ts` / `period.repository.ts` — duplicated deliberately, same reasoning as `web/src/api/svcConfig.ts`'s header. */
export type DayStatus = 'ok' | 'exception' | 'corrected';

export interface DayRecordRow {
  id: string;
  employeeId: string;
  workDate: string;
  actualIn: string | null;
  actualOut: string | null;
  workedHours: string;
  lateMin: string;
  /** 1.5x OT hours, as a decimal-string hours value — engine-computed, never re-derived in this app. */
  ot15x: string;
  /** 2x OT hours. */
  ot2x: string;
  /** 3x OT hours. */
  ot3x: string;
  leaveCode: string | null;
  status: DayStatus;
}

export type PeriodStatus = 'open' | 'locked';

export interface PeriodRow {
  id: string;
  from: string;
  to: string;
  status: PeriodStatus;
  lockVersion: number;
}

export interface TimesheetClient {
  myDays(from: string, to: string): Promise<DayRecordRow[]>;
  listPeriods(): Promise<PeriodRow[]>;
}

export function createTimesheetClient(baseUrl: string, tokens: AuthTokenSource): TimesheetClient {
  const client = createApiClient(baseUrl, tokens);
  return {
    async myDays(from, to) {
      const res = await client.request<{ days: DayRecordRow[] }>(`/my/days?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      return res.days;
    },
    async listPeriods() {
      const res = await client.request<{ periods: PeriodRow[] }>('/periods');
      return res.periods;
    },
  };
}
