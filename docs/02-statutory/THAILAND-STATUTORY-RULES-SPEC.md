# GaDongHR — Thailand Statutory Rules Configuration Specification

| Field | Value |
|---|---|
| Version | 0.1 (Draft) |
| Date | 2026-08-01 |
| Status | Stage 1 deliverable — figures require pre-go-live verification (see §12) |
| Scope | All Thai statutory defaults shipped with GaDongHR, their legal basis, effective dating, amendment governance, and floor validation |

> **Principle:** Every value in this document is *configuration data*, never code. Each rule has: a key, a default value, a legal citation, an effective-date range, a **statutory floor** (the minimum the law allows), and a governance class. Companies may amend upward freely; amendments below the floor are rejected with the citation displayed.

---

## 1. Rules Engine Model

Each rule is stored as an effective-dated, versioned record:

```
rule_key                e.g. leave.annual.min_days
value                   6
unit                    days | percent | THB | hours | multiplier
statutory_floor         6            (null if no legal minimum)
statutory_ceiling       null         (e.g. OT hours cap uses ceiling)
citation                LPA s.30
effective_from          1998-08-19
effective_to            null (open)
governance_class        STATUTORY_FLOOR | STATUTORY_FIXED | COMPANY_POLICY
status                  draft | pending_approval | active | superseded
```

Governance classes:
- **STATUTORY_FIXED** — legally fixed values (tax brackets, SSO rates). Companies cannot change; only rule-pack updates (with approval) can.
- **STATUTORY_FLOOR** — legal minimums (leave days, OT multipliers, severance). Companies may set ≥ floor.
- **COMPANY_POLICY** — no legal constraint (claim limits, extra leave types).

## 2. Legal Framework Overview

| Instrument | Governs |
|---|---|
| Labour Protection Act B.E. 2541 (1998) as amended, incl. **LPA (No. 9) B.E. 2568, in force 7 Dec 2025** | Hours, leave, holidays, OT, severance, records |
| Social Security Act B.E. 2533 | SSO registration & contributions |
| Employee Welfare Fund provisions | EWF contributions from 1 Oct 2026 |
| Revenue Code | PIT withholding, PND filings, record retention |
| Provident Fund Act B.E. 2530 | Voluntary provident funds (2–15%) |
| Personal Data Protection Act B.E. 2562 | See PDPA compliance document |
| Ministerial minimum-wage notifications | Provincial daily minimum wages |

## 3. Leave Entitlements (defaults)

| Rule key | Default | Floor | Pay | Citation / notes |
|---|---|---|---|---|
| leave.annual.min_days | 6 days/yr after 1 full year of service | 6 | 100% | LPA s.30. Pro-rata permitted for <1 yr at employer option (default ON). Unused annual leave: Supreme Court position — employee retains balance/right to payment; default carry-over ON, payout on termination ON |
| leave.sick.paid_days | 30 days/yr | 30 | 100% | LPA s.32, s.57. Medical certificate demandable at ≥3 consecutive days (configurable trigger, floor = may not demand for <3) |
| leave.business.paid_days | 3 days/yr | 3 | 100% | LPA s.34 (necessary personal business) |
| leave.maternity.days | **120 days** per pregnancy | 120 | Employer-paid portion + SSO benefit; configure split per LPA No. 9 rules | LPA No. 9 B.E. 2568, from 7 Dec 2025 (previous regime: 98 days / 45 employer-paid — retained as superseded version effective_to 2025-12-06). **Verify pay-split detail (§12)** |
| leave.paternity.days | **15 days**, full pay | 15 | 100% | LPA No. 9 B.E. 2568, from 7 Dec 2025 (spousal childbirth support) |
| leave.infant_care.days | **15 days** | 15 | **50%** | LPA No. 9 B.E. 2568, from 7 Dec 2025 |
| leave.sterilization | As certified by physician | per cert | 100% | LPA s.33 |
| leave.military.days | Per call-up, paid ≤ 60 days/yr | 60 paid | 100% up to cap | LPA s.35, s.58 |
| leave.training | For exam/skill development per Ministerial Reg. | — | Unpaid unless policy | LPA s.36 |
| leave.ordination | Common company policy (default: 15 days unpaid, editable) | none | policy | Not LPA-mandated for private sector — COMPANY_POLICY class |
| holidays.public.min_per_year | 13 (incl. National Labour Day 1 May) | 13 | 100% | LPA s.29; annual list is company-selected from official announcements; substitute holiday auto-generated when holiday falls on weekly rest day |
| rest.weekly.min_days | 1 day/week, gap ≤ 6 working days | 1 | — | LPA s.28 |

## 4. Working Hours & Overtime

| Rule key | Default | Floor/Ceiling | Citation |
|---|---|---|---|
| hours.regular.max_per_day | 8 | ceiling 8 | LPA s.23 |
| hours.regular.max_per_week | 48 (42 hazardous) | ceiling 48/42 | LPA s.23 |
| hours.ot.max_per_week | 36 | ceiling 36 | LPA s.26 + Ministerial Reg. |
| hours.break.min_after | ≥1 h break after ≤5 h work | floor | LPA s.27 |
| ot.workday.multiplier | 1.5× hourly wage | floor 1.5 | LPA s.61 |
| ot.holiday_work.multiplier | +1× for employees entitled to paid holidays (→2× total); 2× for daily-rate without holiday pay | floor | LPA s.62 |
| ot.holiday_ot.multiplier | 3× | floor 3 | LPA s.63 |
| ot.hourly_base.formula | monthly ÷ 30 ÷ 8 | fairness-validated | Market convention; configurable divisor (30/26/actual) — engine blocks configs producing sub-statutory OT pay |
| ot.consent | OT requires employee consent per instance except emergency work | — | LPA s.24 |

## 5. Social Security Fund (SSO)

| Rule key | Default | Class | Citation / notes |
|---|---|---|---|
| sso.rate.employee | 5% of covered wage | STATUTORY_FIXED | SSA; rate occasionally reduced by temporary relief notifications — apply via effective-dated rule-pack |
| sso.rate.employer | 5% | STATUTORY_FIXED | SSA |
| sso.wage.floor | 1,650 THB/month | FIXED | SSA |
| sso.wage.ceiling | **17,500 THB/month from 1 Jan 2026** (was 15,000; cap 875 THB vs prior 750) | FIXED | Ceiling increase effective 1 Jan 2026 per staged-increase plan (17,500 → 20,000 in 2029 → 23,000 in 2032). **Verify exact gazetted figure (§12)** — superseded 15,000 record retained to 2025-12-31 |
| sso.registration.deadline_days | 30 days from employment start | FIXED | SSA s.34 — drives M1 onboarding task |
| sso.report.monthly | Contribution report + payment by the 15th of following month (สปส.1-10 layout) | FIXED | SSO practice; e-filing supported by SSO e-Service |

## 6. Employee Welfare Fund (EWF)

| Rule key | Default | Citation / notes |
|---|---|---|
| ewf.rate.employee | 0.25% from **1 Oct 2026**; 0.50% from 1 Oct 2031 | Cabinet-approved deferral from 1 Oct 2025. Shipped as two effective-dated records |
| ewf.rate.employer | Same as employee | — |
| ewf.exemption | Employers with a registered provident fund (and other exempt classes) | Engine: if tenant has PF flag = registered, EWF lines suppressed. **Verify exemption scope (§12)** |

## 7. Termination, Notice & Severance (LPA s.17, s.118)

| Service length | Severance (days of last wage) |
|---|---|
| ≥120 days and <1 year | 30 |
| ≥1 and <3 years | 90 |
| ≥3 and <6 years | 180 |
| ≥6 and <10 years | 240 |
| ≥10 and <20 years | 300 |
| ≥20 years | 400 |

- Notice: at least one pay period in advance (or pay in lieu); statutory-cause terminations (s.119) may void severance — final-pay calculator requires HR to record cause with citation.
- Unused annual leave payout on termination: mandatory for accrued entitlement (s.67).
- All values STATUTORY_FLOOR (company may pay more).

## 8. Minimum Wage

- Provincial daily minimum wage table, effective-dated per Ministerial notification. 2026 range approximately **337–400 THB/day** by province (Bangkok and several provinces at the top band; tourist/economic zones raised to 400 in 2025 notifications). Ship full 77-province table as a data pack marked **verify against latest Wage Committee notification (§12)**.
- Engine use: payroll validation — daily-rate employees and monthly-equivalent (÷30) below provincial minimum are blocked; scheduler flags sub-minimum shift pay.

## 9. Personal Income Tax Withholding (Revenue Code)

**Progressive brackets (net annual income, THB) — default pack effective 1 Jan 2026 (verify annually):**

| Bracket | Rate |
|---|---|
| 0 – 150,000 | 0% |
| 150,001 – 300,000 | 5% |
| 300,001 – 500,000 | 10% |
| 500,001 – 750,000 | 15% |
| 750,001 – 1,000,000 | 20% |
| 1,000,001 – 2,000,000 | 25% |
| 2,000,001 – 5,000,000 | 30% |
| > 5,000,000 | 35% |

**Standard deductions/allowances shipped (employee declaration form in ESS, ล.ย.01-equivalent):** expense deduction 50% of income capped 100,000; personal allowance 60,000; spouse 60,000; child 30,000 (60,000 for 2nd+ child born 2018 onward); parental care 30,000/parent; SSO contributions; provident fund; life/health insurance caps; retirement fund caps; plus annually-announced stimulus deductions via rule-pack.

**Withholding method:** annualise monthly income → apply allowances → brackets → ÷ remaining periods (standard RD method), with bonus/one-off handling. **Filings supported (data/export):** PND 1 monthly (due 7th, or 15th e-filing, of following month), PND 1 Kor annual summary (end Feb), 50 bis certificate per employee, PND 91 support data. All STATUTORY_FIXED.

## 10. Other Employer Obligations Driven by the System

| Obligation | System behaviour |
|---|---|
| Work rules registration (≥10 employees) | Compliance checklist alert when headcount crosses 10 |
| **Kor Ror 11** annual employment-conditions report (standing obligation, submitted each January) | Report data pack generated from master data; task auto-created each January |
| Payslip issuance & wage payment ≥ monthly | Enforced by payroll cycle config |
| Permissible wage deductions only (LPA s.76: tax, SSO, union dues, PF, court orders, agreed debts with consent caps) | Deduction types whitelisted; free-form deductions require s.76 category + consent record; total deduction caps enforced |
| Employee register & wage records retention | See PDPA doc §7 — LPA s.112/s.114–115: employee register kept ≥2 years after termination; wage/OT payment documents ≥2 years; tax records ≥5 years (Revenue Code); accounting 5 years |

## 11. Amendment Governance Workflow

1. **Propose** — HR Admin edits a rule (new value + effective date + reason). Saved as `draft`.
2. **Validate** — engine checks class: STATUTORY_FIXED → editable only via signed rule-pack import; STATUTORY_FLOOR → new value ≥ floor else rejected showing citation; effective-date overlap resolved by auto-closing the prior version.
3. **Approve** — a second privileged user (System Admin or Compliance role; proposer ≠ approver) approves → `active` at effective date. Payroll-impacting rules changed mid-period trigger a mandatory variance note on the next run.
4. **Audit** — every version immutable; diff view (old→new, who, when, why); auditors get read access.
5. **Rule packs** — the authority of record for law-change updates is the vendor/maintainer: signed JSON packs (e.g., `TH-2027-TAX`) imported with the same approval step; system warns when active packs approach known future effective dates (EWF 1 Oct 2026 pre-loaded).

## 12. Verification Log (complete before go-live)

| # | Item | Why flagged | Source of truth |
|---|---|---|---|
| V1 | Maternity 120-day pay split (employer vs SSO days) under LPA No. 9 | New law, detail not confirmed in Stage 1 sources | Royal Gazette text of LPA (No. 9) B.E. 2568 |
| V2 | SSO ceiling exact 2026 figure (17,500 assumed) & transition | Staged-increase plan vs final gazette | Royal Gazette / SSO announcement |
| V3 | EWF exemption scope & remittance mechanics | Newly effective 1 Oct 2026 | Ministry of Labour regulations |
| V4 | 2026 provincial minimum-wage full table | Changes multiple times/yr | Wage Committee notification |
| V5 | Current-year PIT stimulus deductions | Annual announcements | Revenue Department |
| V6 | Pending LPA draft bills (first reading Sept 2025: hours/annual-leave/anti-discrimination) | Not yet law — do NOT ship as defaults; monitor | Parliament / Royal Gazette |
| V7 | Kor Ror 11 current form layout & portal | Standing obligation, form revisions possible | DLPW |

> **Disclaimer:** This specification is an engineering configuration document, not legal advice. Final defaults must be reviewed by qualified Thai counsel before production use.
