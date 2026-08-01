# M3 Timesheet — Test Document
Refs: PRD M3-1…M3-7 · `../05-modules/M3-TIMESHEET.md`

| ID | Verifies | Scenario / Steps | Expected |
|---|---|---|---|
| TC-M3-001 | M3-1 | In 08:58 / out 18:05 vs 09:00–18:00 shift, grace 5min | worked hours correct; late 0; no exception |
| TC-M3-002 | M3-1 | In 09:20 | late 20 min; late exception raised |
| TC-M3-003 | M3-1 | Night shift punches 21:55 / next-day 06:10 | Paired to shift start date; hours correct |
| TC-M3-004 | M3-1 | Only IN punch by day end | missed_punch exception |
| TC-M3-005 | M3-1 | Approved sick day, no punches | leave code applied, paid per type, no absence exception |
| TC-M3-006 | M3-2 | 2h approved workday OT worked | ot_15x = 2.0 |
| TC-M3-007 | M3-2 | Monthly employee works public holiday 8h + 2h OT | 8h at +1× (holiday work) + 2h at 3×; daily-rate variant: 8h at 2× |
| TC-M3-008 | M3-2 | Worked 2h OT, no approval | unapproved_ot exception; hours neither paid nor dropped until regularised |
| TC-M3-009 | M3-2 | Hourly base config divisor 30 vs attempt sub-statutory custom divisor | Custom accepted only if ≥ statutory result; else TSH-040 at config layer |
| TC-M3-010 | M3-3 | Manager proposes fix; HR confirms | Day recomputed; audit stores who/when/why + before/after |
| TC-M3-011 | M3-4 | Lock with open blocking exception | 409 TSH-030 |
| TC-M3-012 | M3-4 | Lock clean period → payroll pulls | timesheet.locked v1; payroll binds v1 |
| TC-M3-013 | M3-4 | Unlock (Payroll Approver + reason) → correct → re-lock | v2 published; payroll shows stale-lock PAY-030 until recalc; variance report flags forced |
| TC-M3-014 | M3-4 | Unlock attempt by HR Officer role | 403 (permission payroll.run.approve required) |
| TC-M3-015 | M4-4 AC | Redeliver same punch ×3 (idemKey) | Single day-record effect |
| TC-M3-016 | Perf | 10 punches/sec for 60s across 50 employees | 0 lost; consolidation lag <5s p95 |
| TC-M3-017 | RBAC | Employee requests another employee's days | 403; own via /my only |
| TC-M3-018 P1 | M3-6 | PWA punch outside geofence radius | Flagged per site policy |
