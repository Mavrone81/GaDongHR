/**
 * Repeatable integration proof for the mobile app's own API clients
 * against the REAL local stack (task brief: "Integrate and verify against
 * the real local stack ... your integration evidence must come from the
 * app's clients hitting that real stack — real punch, real leave request,
 * real timesheet read").
 *
 * Reuses `test/e2e/harness.ts`'s compose (same rationale as
 * `test/e2e/run.ts`) rather than a second, parallel stack definition —
 * this app does not own `test/e2e/`, so nothing here duplicates or edits
 * it, only imports its exported `up`/`down`/`PORTS`/`PERSONAS`/`mintToken`
 * and the DB seeding helpers `test/e2e/lib/db.ts` already exports for
 * exactly this kind of standalone script.
 *
 * Run: `pnpm --filter @gadong/mobile integration-check`
 *   - Brings the stack up itself by default (self-contained, repeatable).
 *   - `E2E_ATTACH=1`: skip `up()` and attach to a stack already running
 *     (e.g. left up via `E2E_KEEP_STACK=1 pnpm test:e2e`).
 *   - `E2E_KEEP_STACK=1`: leave the stack running afterward (same flag
 *     name/meaning as `test/e2e/run.ts`).
 *
 * WHAT THIS PROVES, HONESTLY:
 *   - attendance: a REAL `POST /punches/code` through this app's own
 *     `svcAttendance.ts` client. The realistic outcome (task brief, e2e
 *     findings) is a 4xx `invalidAlternativeCredential` — PIN enrolment is
 *     out of scope — and this script asserts nothing about the punch
 *     succeeding, only that the ROUTE answers for real through this app's
 *     client code, exactly like `test/e2e/lifecycle.e2e.test.ts`'s own
 *     equivalent assertion.
 *   - timesheet: a REAL `GET /my/days` (200, real data or a real empty
 *     list) and `GET /periods` (a real 403 for an employee-scoped token,
 *     which `TimesheetScreen.tsx` already treats as "hide the section",
 *     not an error) — both through `svcTimesheet.ts`.
 *   - payroll: a REAL `GET /my/payslips` through `svcPayroll.ts` — 200
 *     with an empty list, since this script's synthetic employee
 *     (`PERSONAS.employee`) has no committed payroll run; the underlying
 *     route's real figures are proven end-to-end separately by
 *     `test/e2e/lifecycle.e2e.test.ts`'s "THE MONEY ASSERTION" test.
 *   - leave: NOT exercised — `svc-leave` is not part of this compose
 *     stack (task brief, API reality) and has no port to call. Logged as
 *     skipped, not silently omitted.
 */
import { up, down, PORTS, PERSONAS, mintToken } from '../../test/e2e/harness';
import { grantRole, waitForRoleSeeded } from '../../test/e2e/lib/db';
import { createAttendanceClient } from '../src/api/svcAttendance';
import { createTimesheetClient } from '../src/api/svcTimesheet';
import { createPayrollClient } from '../src/api/svcPayroll';
import { ApiError } from '../src/api/httpClient';
import type { AuthTokenSource } from '../src/api/httpClient';

function staticTokenSource(token: string): AuthTokenSource {
  return {
    getAccessToken: () => token,
    refresh: async () => null,
    onUnauthorized: () => undefined,
  };
}

interface TranscriptEntry {
  step: string;
  outcome: string;
}

const transcript: TranscriptEntry[] = [];

function record(step: string, outcome: string): void {
  transcript.push({ step, outcome });
  console.log(`[integration-check] ${step} -> ${outcome}`);
}

async function attempt<T>(step: string, fn: () => Promise<T>, describe: (value: T) => string): Promise<T | null> {
  try {
    const value = await fn();
    record(step, describe(value));
    return value;
  } catch (err) {
    if (err instanceof ApiError) {
      record(step, `HTTP ${String(err.status)} ${err.envelope ? `${err.envelope.code}: ${err.envelope.message_i18n_key}` : '(no envelope)'}`);
      return null;
    }
    record(step, `THREW: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const attach = process.env['E2E_ATTACH'] === '1';
  if (attach) {
    console.log('[integration-check] E2E_ATTACH=1 — attaching to an already-running stack, skipping up()');
  } else {
    console.log('[integration-check] bringing up the real test/e2e stack (this can take several minutes)...');
    await up();
  }

  try {
    // svc-authz seeds ROLE_TEMPLATES (including 'employee-ess') on boot —
    // a short poll rather than a fixed sleep, matching harness.ts's own
    // `waitForHealthy`/`waitForCryptoReady` "poll, don't guess" pattern.
    const deadline = Date.now() + 60_000;
    let seeded = false;
    while (Date.now() < deadline) {
      seeded = await waitForRoleSeeded('employee-ess');
      if (seeded) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!seeded) throw new Error('authz.role "employee-ess" was never seeded — is svc-authz up?');

    await grantRole(PERSONAS.employee, 'employee-ess', PERSONAS.seeder);
    const employeeToken = await mintToken(PERSONAS.employee);
    const tokens = staticTokenSource(employeeToken);
    record('auth', `minted a real RS256 token for PERSONAS.employee (${PERSONAS.employee}) from the e2e oidc-issuer stand-in, granted 'employee-ess'`);

    const attendance = createAttendanceClient(`http://127.0.0.1:${String(PORTS.attendance)}`, tokens);
    const timesheet = createTimesheetClient(`http://127.0.0.1:${String(PORTS.timesheet)}`, tokens);
    const payroll = createPayrollClient(`http://127.0.0.1:${String(PORTS.payroll)}`, tokens);

    const idemBase = `integration-check-${Date.now().toString(36)}`;
    await attempt(
      'svcAttendance.punchByCode(in)',
      () =>
        attendance.punchByCode({
          idemKey: `${idemBase}-in`,
          direction: 'in',
          siteCode: 'HQ',
          punchedAt: new Date().toISOString(),
          deviceId: 'integration-check',
          kind: 'pin',
          code: '000000',
        }),
      (r) => `punch id=${r.punch.id} duplicate=${String(r.duplicate)}`,
    );

    await attempt('svcAttendance.myPunches(last 7 days)', () => attendance.myPunches(isoDaysAgo(7), isoToday()), (rows) => `${String(rows.length)} punch row(s)`);

    await attempt('svcTimesheet.myDays(last 7 days)', () => timesheet.myDays(isoDaysAgo(7), isoToday()), (rows) => `${String(rows.length)} day record(s)`);

    await attempt(
      'svcTimesheet.listPeriods() [expects 403 — timesheet.lock is HR-only, not part of employee-ess]',
      () => timesheet.listPeriods(),
      (rows) => `${String(rows.length)} period(s) — unexpectedly permitted`,
    );

    await attempt('svcPayroll.myPayslips()', () => payroll.myPayslips('th'), (rows) => `${String(rows.length)} payslip(s)`);

    record('svcLeave', 'SKIPPED — svc-leave is not part of test/e2e/docker-compose.yml (API reality, task brief); no port to call');

    console.log('\n[integration-check] transcript summary:');
    for (const entry of transcript) console.log(`  - ${entry.step}: ${entry.outcome}`);
  } finally {
    if (process.env['E2E_KEEP_STACK'] === '1' || attach) {
      console.log('[integration-check] leaving the stack as-is (E2E_KEEP_STACK=1 or E2E_ATTACH=1)');
    } else {
      await down();
    }
  }
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err: unknown) => {
    console.error('[integration-check] fatal error:', err);
    process.exitCode = 1;
  });
