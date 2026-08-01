# M5 Leave — Test Document
Refs: PRD M5-1…M5-7 · `../05-modules/M5-LEAVE.md` · Statutory Spec §3

| ID | Verifies | Scenario / Steps | Expected |
|---|---|---|---|
| TC-M5-001 | M5-1 | Lower annual leave type to 5 days | 422 LVE-030 with LPA s.30 citation |
| TC-M5-002 | M5-1 | Raise annual to 12 days; add company type "birthday leave" | Accepted (≥floor / COMPANY_POLICY) |
| TC-M5-003 | M5-1 | Sick request 3 consecutive days without cert | LVE-011 cert required; 2 days → no cert demanded |
| TC-M5-004 | M5-1 | Maternity request dated Nov 2025 vs Jan 2026 (clock service) | Resolves 98-day rule vs 120-day rule per effective dating |
| TC-M5-005 | M5-1 | Paternity 15d, infant-care 15d requests | Approved; infant-care day lands in Timesheet with 50%-pay code (verify M7 pays 50% — TC-M7-009) |
| TC-M5-006 | M5-2 | New joiner mid-year, monthly accrual | Pro-rated entitlement correct to the day |
| TC-M5-007 | M5-2 | Year-end with 3 unused annual days, carry-over ON | carried_over=3; ledger entries balance |
| TC-M5-008 | M5-3 | Request exceeding balance | LVE-010 (unless type allows negative) |
| TC-M5-009 | M5-3 | Overlapping dates with pending request | LVE-020 |
| TC-M5-010 | M5-3 | Two-level chain; L1 approver on leave | Delegation routes to delegate; both recorded |
| TC-M5-011 | M5-4 | Approved leave day | Timesheet paid/unpaid per type; Scheduler collision warning active (TC-M2-003) |
| TC-M5-012 | M5-2 | Terminate employee with 4 unused annual days | leave.balance_payout emitted; final pay includes payout at correct wage (TC-M7-013) |
| TC-M5-013 | M5-5 | zh-preferring employee views balances & projection | Fully zh UI; projected balance at future date correct |
| TC-M5-014 | M5-3 | Cancel approved future leave | leave.cancelled; balance restored; Timesheet/Scheduler updated |
| TC-M5-015 | Ledger | Random 50-operation fuzz (grant/take/adjust/cancel) | balance == Σledger always |
| TC-M5-016 | RBAC | HR adjusts balance without leave.balance.adjust | 403; with permission → ledger + audit reason required |
| TC-M5-017 P1 | M5-6 | Team calendar concurrency limit 2/day | 3rd overlapping request flagged/blocked per policy |
