# M7 — Payroll: Module Design (Workflows · Classes · API)

| Field | Value |
|---|---|
| Service | `svc-payroll` · schema `payroll` · base path `/api/payroll` |
| Version | 0.1 (Draft) · Date 2026-08-02 · Stage 3b |
| PRD refs | M7-1…M7-12 · Statutory Spec §4–§9 (OT, SSO, EWF, PIT, min wage), §7 (severance) |

## 1. Workflows

### 1.1 Regular run lifecycle (M7-3) — segregation of duties

```mermaid
stateDiagram-v2
    [*] --> draft: Payroll Officer opens period run
    draft --> calculated: calculate()<br/>binds timesheet lock_version +<br/>statutory rulepack snapshot
    calculated --> reviewed: variance review<br/>vs previous period, threshold flags
    reviewed --> approved: Payroll Approver<br/>guard prepared_by ≠ approved_by<br/>step-up re-auth
    approved --> committed: commit → immutable<br/>payroll.committed event
    calculated --> draft: recalc (config/timesheet change)
    reviewed --> draft: rework
    committed --> [*]: corrections only via<br/>adjustment/off-cycle runs
    note right of calculated: timesheet.unlocked after calc<br/>⇒ forced variance report + recalc
```

### 1.2 Gross-to-net sequence (M7-2) — statutory order

```mermaid
flowchart TD
    A[Earnings: base pay basis monthly/daily/hourly<br/>+ OT from locked timesheet 1.5x/2x/3x<br/>+ taxable allowances + shift differentials] --> MW{Min-wage check<br/>vs employee province}
    MW -- below floor --> STOP[Line blocked PAY-010]
    MW -- ok --> B[Leave pay adjustments<br/>per_rule types: infant-care 50%,<br/>maternity split, unpaid deductions]
    B --> C[SSO: 5% × capped wage<br/>ceiling from config effective-dated<br/>employer matches]
    C --> D{EWF applicable?<br/>run date ≥ 1 Oct 2026 AND<br/>no registered provident fund}
    D -- yes --> E[EWF 0.25% employee + employer]
    D -- no --> F
    E --> F[Provident fund 2–15% per profile]
    F --> G[WHT: annualise YTD + projected<br/>− expense 50% cap 100k − allowances decl<br/>→ brackets → ÷ remaining periods<br/>bonus month: one-off method]
    G --> H[+ Non-taxable reimbursements claims<br/>outside tax & SSO base]
    H --> I[Net pay → payslip 🔐<br/>+ employer cost lines]
```

Every rate/ceiling/bracket resolves from `svc-config` **as of the period date** — the September vs October 2026 EWF test in PRD M7-2 AC is the canonical proof.

### 1.3 Termination / final pay (M7-7)

```mermaid
flowchart LR
    T{{employee.terminated}} --> R[Final-pay run type]
    R --> W[Outstanding wages + OT to last day]
    R --> L[Unused annual leave payout<br/>from leave.balance_payout]
    R --> S{Reason category}
    S -- employer termination, no s.119 cause --> SV[Severance by tenure<br/>30/90/180/240/300/400 days]
    S -- s.119 cause recorded --> NS[No severance — cause + citation stored]
    S -- resignation --> NS2[No severance]
    R --> N[Pay in lieu of notice if applicable]
    SV & NS & NS2 & N & W & L --> F[Itemised final payslip<br/>WHT on termination amounts per RD rules]
```

### 1.4 Statutory export generation (M7-6)

```mermaid
flowchart TD
    C[Committed run] --> X1[SSO สปส.1-10 layout<br/>monthly, due 15th following]
    C --> X2[PND 1 data export<br/>due 7th / 15th e-file]
    C --> X3[Bank transfer file<br/>generic CSV + 2 bank templates]
    Y[Year-end job] --> X4[PND 1 Kor summary]
    Y --> X5[50 bis per employee th/en]
    J[January job] --> X6[Kor Ror 11 data pack]
    X1 & X2 & X3 & X4 & X5 & X6 --> S[Encrypted in MinIO ·<br/>download audited · manual e-file v1]
```

## 2. Class Diagram

```mermaid
classDiagram
    class PayProfile {
      +UUID employeeId
      +EncryptedField basePay
      +PayBasis basis
      +List~RecurringItem~ items
      +EncryptedField pfRate
      +EncryptedBlob taxAllowanceDecl  // ล.ย.01
    }
    class PayrollRun {
      +Period period
      +RunType type  // regular|offcycle|adjustment|final_pay
      +int timesheetLockVersion
      +RunStatus status
      +UUID preparedBy/approvedBy  // SoD constraint
      +Json rulepackSnapshot
      +calculate() +approve(by) +commit()
    }
    class GrossToNetEngine {
      +compute(emp, period) Payslip
      -earnings(timesheet, profile)
      -ssoCapped(wage, ceilingAsOf)
      -ewfIfApplicable(dateGate, pfFlag)
      -whtAnnualised(ytd, decl, brackets)
      -minWageGuard(province)
    }
    class StatutoryRuleResolver { +valueAsOf(ruleKey, date) // effective-dated }
    class Payslip { +🔐 gross/sso/ewf/pf/wht/net/ytd +renderPdf(lang) // B.E. on th }
    class BankFileBuilder { +build(format, lines) // KBank/SCB/generic }
    class StatutoryExporter { +sso110() +pnd1() +pnd1kor() +fiftyBis() +korRor11() }
    class SeveranceCalculator { +tiers(tenure) days +compute(lastWage, reason) }
    PayrollRun --> GrossToNetEngine
    GrossToNetEngine --> StatutoryRuleResolver
    GrossToNetEngine --> PayProfile
    PayrollRun --> Payslip
    PayrollRun --> BankFileBuilder
    PayrollRun --> StatutoryExporter
    SeveranceCalculator --> PayrollRun : final_pay
```

## 3. API Manual

All payroll endpoints require step-up re-auth for approve/commit/export download. Amount fields encrypted at rest; API returns plaintext only to authorised roles and audits reads.

| # | Method & Path | Permission | Description |
|---|---|---|---|
| 1 | `GET/POST/PATCH /profiles/{employeeId}` | `payroll.profile.manage` | Pay basis, recurring items, PF rate, tax declaration |
| 2 | `POST /runs` | `payroll.run.prepare` | `{period, type}` → draft; binds current timesheet lock |
| 3 | `POST /runs/{id}/calculate` | `payroll.run.prepare` | Executes gross-to-net for all in-scope employees; snapshot of rulepack versions stored |
| 4 | `GET /runs/{id}/variance?threshold` | prepare/approve | Line-level diff vs previous period; unlock-forced flags |
| 5 | `POST /runs/{id}/approve` | `payroll.run.approve` | Guard `prepared_by ≠ approved_by` → 403 `PAY-020`; step-up |
| 6 | `POST /runs/{id}/commit` | `payroll.run.approve` | Immutable; publishes `payroll.committed`; triggers payslip render |
| 7 | `GET /runs/{id}/payslips` · `GET /my/payslips` | officer (scoped) / self | List + PDF refs; self access audited-light |
| 8 | `POST /runs/{id}/bank-file?format=kbank\|scb\|generic` | `payroll.disburse` | Net-pay file; download audited |
| 9 | `POST /runs/{id}/exports/{kind}` | `payroll.statutory.export` | kind ∈ sso_1_10 · pnd1 · pnd1kor · fifty_bis · kor_ror_11 |
| 10 | `POST /final-pay/{employeeId}` | `payroll.run.prepare` | Final-pay run: wages, leave payout, severance (reason-driven), notice in lieu — itemised |
| 11 | `POST /adjustment-runs` | `payroll.run.prepare` | Corrections referencing a committed run (never mutate it) |
| 12 | `GET /reports/employer-cost?period` | `payroll.report` | SSO/EWF/PF employer lines, cost by org unit |

### Events

| Direction | Event | Payload |
|---|---|---|
| in | `timesheet.locked/unlocked` | bind/flag lock versions |
| in | `leave.balance_payout`, `claim.approved_for_payroll`, `employee.terminated` | run inputs |
| out | `payroll.committed` | runId, period, employeeIds (no amounts) |
| out | `payslip.issued` | employeeId, period → notify svc |

### Error codes (extract)
`PAY-010` pay below provincial minimum wage (province + floor cited) · `PAY-012` NO minimum-wage notification on file for the employee's province — fails closed, blocks the run rather than emitting a payslip note (see the roadmap's unverified-statutory-figures section, §12 V4) · `PAY-020` SoD violation preparer=approver · `PAY-021` commit without approval · `PAY-030` timesheet lock version stale (unlock occurred) — recalc required · `PAY-040` missing tax declaration → default single-allowance basis applied with warning · `PAY-050` export before commit.

## 4. Test Hooks (feeds Stage 4 + parallel-run plan)
Canonical fixtures: (a) Sep-2026 vs Oct-2026 EWF gate; (b) SSO ceiling boundary salary at old/new ceiling effective dates; (c) OT-heavy daily-rate employee incl. 3× holiday OT; (d) infant-care 50% mid-month; (e) bonus-month WHT; (f) termination at 3 years −1 day vs +1 day (90 vs 180 severance days); (g) claims reimbursement excluded from SSO/tax base; (h) preparer attempting self-approval rejected; (i) committed-run mutation attempt blocked at DB; (j) two full parallel runs vs incumbent ≤0.5% variance (PRD success metric).
