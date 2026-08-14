import { useMemo } from 'react';
import { loadConfig, resolveServiceUrl } from './env';
import type { AuthTokenSource } from './httpClient';
import { createAttendanceClient } from './svcAttendance';
import type { AttendanceClient } from './svcAttendance';
import { createTimesheetClient } from './svcTimesheet';
import type { TimesheetClient } from './svcTimesheet';
import { createLeaveClient } from './svcLeave';
import type { LeaveClient } from './svcLeave';
import { createPayrollClient } from './svcPayroll';
import type { PayrollClient } from './svcPayroll';

export interface ApiClients {
  attendance: AttendanceClient;
  timesheet: TimesheetClient;
  leave: LeaveClient;
  payroll: PayrollClient;
}

/**
 * One memoized bundle of every authenticated service client this app
 * talks to, keyed off the same `AuthTokenSource` `auth/AuthContext.tsx`
 * hands `api/httpClient.ts` — mirrors `web/src/api/svcConfig.ts`'s
 * `useSvcConfig()` pattern, just built once for all four services instead
 * of repeating the `useMemo` per file.
 */
export function useApiClients(tokens: AuthTokenSource): ApiClients {
  return useMemo(() => {
    const config = loadConfig();
    return {
      attendance: createAttendanceClient(resolveServiceUrl(config, 'attendance'), tokens),
      timesheet: createTimesheetClient(resolveServiceUrl(config, 'timesheet'), tokens),
      leave: createLeaveClient(resolveServiceUrl(config, 'leave'), tokens),
      payroll: createPayrollClient(resolveServiceUrl(config, 'payroll'), tokens),
    };
  }, [tokens]);
}
