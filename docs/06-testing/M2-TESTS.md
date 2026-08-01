# M2 Scheduler — Test Document
Refs: PRD M2-1…M2-7 · `../05-modules/M2-SCHEDULER.md`

| ID | Verifies | Scenario / Steps | Expected |
|---|---|---|---|
| TC-M2-001 | M2-1 | Create night shift 22:00–06:00 | crossesMidnight true; duration attributes to start date |
| TC-M2-002 | M2-2 | Assign overlapping second shift same day | 422 SCH-011 |
| TC-M2-003 | M2-2 | Roster employee on approved-leave date | 200 + warn SCH-012; publish blocked until override with reason; override recorded |
| TC-M2-004 | M2-4 | 9th regular hour in a day / 49th weekly hour | Blocked SCH-010 with rule key + citation |
| TC-M2-005 | M2-4 | Hazardous org unit at 43rd weekly hour | Blocked (42h ceiling) |
| TC-M2-006 | M2-4 | 7th consecutive working day (rest-day gap) | Blocked/warned per rule class |
| TC-M2-007 | M2-3 | Set year list with 12 holidays | 422 SCH-030 citation LPA s.29 |
| TC-M2-008 | M2-3 | Holiday falls on employee's weekly rest day | Substitute holiday auto-created next working day; visible to Timesheet |
| TC-M2-009 | M2-5 | OT request without employee consent flag (non-emergency) | 422 SCH-021 |
| TC-M2-010 | M2-5 | Approve OT taking week to 37 OT hours | 422 SCH-020 |
| TC-M2-011 | M2-5 | Approved OT → ot.approved consumed by Timesheet | OT allowance visible on day record |
| TC-M2-012 | M2-2 | Publish roster | roster.published; employees notified in own language (th/en/zh sample) |
| TC-M2-013 | XC-EVENTS | Redeliver roster.published ×3 | Timesheet day records unchanged after first |
| TC-M2-014 P1 | M2-6 | Shift swap request→counterpart accept→manager approve | Roster updated; audit trail of all three actors |
| TC-M2-015 | RBAC | Manager rosters employee outside own org scope | 403 |
