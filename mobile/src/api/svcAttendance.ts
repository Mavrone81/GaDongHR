import { createApiClient } from './httpClient';
import type { AuthTokenSource } from './httpClient';

/**
 * Wire types mirroring `services/svc-attendance/src/punch.controller.ts`
 * (`CodePunchBody`, `PunchRow`) — duplicated deliberately rather than
 * imported, same reasoning as `web/src/api/svcConfig.ts`'s header: a
 * service's server-only source is out of this app's ownership and out of
 * bundling reach.
 */
export type PunchDirection = 'in' | 'out';

export interface PunchRow {
  id: string;
  employeeId: string;
  direction: PunchDirection;
  siteCode: string;
  punchedAt: string;
  method: string;
  matchScore: number | null;
  livenessPassed: boolean | null;
}

export interface CodePunchInput {
  idemKey: string;
  direction: PunchDirection;
  siteCode: string;
  /** ISO-8601 instant. */
  punchedAt: string;
  deviceId: string;
  /** `'pin'` — the alternative-credential kind this app supports (kiosk keypad / self-service). Note (task brief, e2e findings): a punch here 4xx's with `invalidAlternativeCredential` for any employee who has not separately completed PIN enrolment via `POST /enrolments/alternative` — out of this app's scope today. */
  kind: 'pin';
  code: string;
  employeeId?: string;
}

export interface AttendanceClient {
  punchByCode(input: CodePunchInput): Promise<{ punch: PunchRow; duplicate: boolean }>;
  myPunches(from: string, to: string): Promise<PunchRow[]>;
}

export function createAttendanceClient(baseUrl: string, tokens: AuthTokenSource): AttendanceClient {
  const client = createApiClient(baseUrl, tokens);
  return {
    async punchByCode(input) {
      return client.request(`/punches/code`, { method: 'POST', body: JSON.stringify(input) });
    },
    async myPunches(from, to) {
      const res = await client.request<{ punches: PunchRow[] }>(`/my/punches?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      return res.punches;
    },
  };
}
