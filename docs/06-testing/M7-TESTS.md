# M7 Payroll — Test Document
Refs: PRD M7-1…M7-7 · `../05-modules/M7-PAYROLL.md` · Statutory Spec §4–§9. Golden-file fixtures under `fixtures/payroll/` (created in build phase); accountant-recomputed expected values.

| ID | Verifies | Scenario / Steps | Expected |
|---|---|---|---|
| TC-M7-001 | M7-1 | Daily-rate employee in province P below provincial min wage | Line blocked PAY-010 with province + floor cited |
| TC-M7-002 | M7-2 | Monthly 30,000 THB, no extras, 2026 rules | SSO = 875 (5% of 17,500 ceiling) employee+employer; WHT matches golden file |
| TC-M7-003 | M7-2 | Salary exactly at ceiling boundary, Dec 2025 vs Jan 2026 runs | 750 cap vs new cap per effective-dated ceiling |
| TC-M7-004 | M7-2 | Sep 2026 run vs Oct 2026 run, no provident fund | EWF absent vs 0.25%+0.25% present — config only, no deploy |
| TC-M7-005 | M7-2 | Employer with registered PF flag, Oct 2026 | EWF suppressed |
| TC-M7-006 | M7-2 | OT-heavy daily-rate: 6h 1.5× + holiday 8h 2× + 2h 3× | Gross matches golden file to satang |
| TC-M7-007 | M7-2 | Bonus month (1 extra salary) | One-off WHT method; annualised tax correct vs golden file |
| TC-M7-008 | M7-2 | Employee with child+parent allowances declared vs no declaration | Correct bracket math; missing decl → PAY-040 default basis + warning |
| TC-M7-009 | M5 link | Month containing 5 infant-care days | Those days paid at 50%; payslip itemised |
| TC-M7-010 | M6 link | 1,500 THB reimbursement in run | Net includes it; SSO & taxable bases exclude it |
| TC-M7-011 | M7-3 | Preparer calls approve on own run | 403 PAY-020 (also DB-level test: direct SQL update rejected by constraint) |
| TC-M7-012 | M7-3 | Timesheet unlocked after calculate | PAY-030 stale lock; recalc binds v2; variance report flags forced rows |
| TC-M7-013 | M7-7 | Terminations at 119d/121d/2.9y/3.1y/9y/21y, employer-initiated no cause | Severance 0/30/90/180/240/400 days of last wage; leave payout included; itemised |
| TC-M7-014 | M7-7 | Termination with s.119 cause recorded | No severance; cause + citation stored; audit |
| TC-M7-015 | M7-3 | Mutate committed run via API and via SQL | API 409; DB trigger rejects |
| TC-M7-016 | M7-4 | Payslips th/en/zh for same employee | th shows พ.ศ.; zh CJK correct in PDF; YTD accurate; access by other employee 403 |
| TC-M7-017 | M7-5 | Bank file kbank & generic for run | Format spec valid; totals = Σnet |
| TC-M7-018 | M7-6 | สปส.1-10 + PND 1 exports | Layout matches spec; figures = run aggregates; download audited |
| TC-M7-019 | M7-6 | Year-end: PND 1 Kor + 50 bis for fixture year | 50 bis per employee totals = Σmonthly WHT |
| TC-M7-020 | Perf | 1,000-employee synthetic run | < 10 min end-to-end |
| TC-M7-021 | Regression | Import next-year rule pack (changed brackets) | Old-period recalc unchanged (snapshot); new period uses new pack |
| TC-M7-022 | XC-CRYPTO | pg_dump of payroll schema | No plaintext salary/net values present |
| TC-M7-023 | M7-3 | Adjustment run correcting committed run | References original; delta payslip; original untouched |
| TC-M7-024 | UAT | Parallel run months 1–2 vs incumbent | ≤0.5% then 0 unexplained variance |
