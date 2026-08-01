# M6 Claims — Test Document
Refs: PRD M6-1…M6-5 · `../05-modules/M6-CLAIMS.md`

| ID | Verifies | Scenario / Steps | Expected |
|---|---|---|---|
| TC-M6-001 | M6-1 | Claim over per-claim hard limit | 422 CLM-010 |
| TC-M6-002 | M6-1 | Soft monthly limit exceeded | Accepted; approver sees flag |
| TC-M6-003 | M6-2 | Submit without required receipt | CLM-012 |
| TC-M6-004 | M6-2 | EICAR as receipt | AV reject; security audit |
| TC-M6-005 | M6-2 | Mileage 42.5 km at config rate | amount = km × rate exactly |
| TC-M6-006 | M6-3 | 1,999 vs 2,001 THB claims | Manager-only chain vs manager+finance chain |
| TC-M6-007 | M6-3 | L2 approver decides an L1-band claim they lack band permission for | 403 CLM-020 |
| TC-M6-008 | M6-5 | Same amount+date+vendor twice | Second flagged/blocked CLM-011 |
| TC-M6-009 | M6-3 | Reject → resubmit | New version linked; history preserved |
| TC-M6-010 | M6-4 | Route to payroll | claim.approved_for_payroll; payslip shows non-taxable line; excluded from SSO & tax base (assert with TC-M7-010) |
| TC-M6-011 | M6-4 | Off-cycle batch of 5 claims → bank file → mark paid | File total = Σclaims; statuses paid_offcycle; employee sees status trail |
| TC-M6-012 | M6-4 | payroll.committed redelivered ×3 | for_payroll→paid transition exactly once |
| TC-M6-013 | M6-4 | Route change after payroll pull | 409 CLM-030 |
| TC-M6-014 | RBAC | Employee A reads B's claim | 403 |
| TC-M6-015 | i18n | Full claim cycle in zh | All screens/notifications zh; amounts THB formatted |
