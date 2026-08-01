# GaDongHR — Product Requirements Document (PRD)

| Field | Value |
|---|---|
| Product | GaDongHR — Thailand HRMS |
| Version | 0.1 (Draft for review) |
| Date | 2026-08-01 |
| Status | Stage 1 deliverable — pending stakeholder review |
| Owner | Product Owner (Mavrone81) |
| Related docs | `docs/02-statutory/THAILAND-STATUTORY-RULES-SPEC.md`, `docs/03-compliance/PDPA-BIOMETRIC-COMPLIANCE.md` |

---

## 1. Problem Statement

Thai SMEs and mid-market companies (10–1,000 employees) manage HR through a patchwork of spreadsheets, paper leave forms, standalone fingerprint machines, and outsourced payroll. This creates three recurring failures: (a) attendance data never reconciles cleanly with timesheets and payroll, causing wage disputes; (b) Thai statutory compliance (Labour Protection Act leave entitlements, Social Security Fund filings, PND 1 withholding tax, and the December 2025 LPA No. 9 amendments) is applied inconsistently and exposes employers to Labour Court claims and Department of Labour inspection findings; and (c) foreign-managed companies (notably Chinese-invested manufacturers) cannot operate the systems because local tools are Thai-only.

Existing local products (EzyHR, TigerSoft, Business Plus, Prosoft HRMI, Humanica) cover parts of this but are closed SaaS products: customers cannot self-host, cannot audit how their sensitive data is encrypted, and rarely offer Mandarin. GaDongHR is a self-hostable (Docker Compose), microservices HRMS with attendance-to-payroll data flow as a single pipeline, Thai statutory rules as versioned, amendable configuration, field-level encryption before data reaches the database, and full Thai/English/Mandarin UI.

## 2. Goals

1. **Zero-touch attendance-to-payroll pipeline**: facial-recognition clock events flow to timesheets and payroll with no manual re-entry; ≥95% of pay periods close without manual attendance corrections.
2. **Compliance by default**: a new tenant is statutorily compliant on day one using shipped Thai default rules (leave, OT, SSO, tax); any amendment below the statutory floor is blocked. Target: 100% of shipped defaults traceable to a legal citation with effective date.
3. **Self-hosted in under 1 hour**: `docker compose up` brings up the full system (all services, database, broker, face engine, key manager) on a single host; documented install completes in <60 minutes.
4. **Trilingual operation**: every screen, notification, payslip, and document renders correctly in Thai, English, and Simplified Chinese, including Buddhist Era dates on Thai-facing documents.
5. **Provable data protection**: all PDPA sensitive data (biometric templates, national ID, health data) is encrypted at the application layer before database write; a DB dump alone must reveal no readable sensitive field. RBAC denies-by-default across every API.

## 3. Non-Goals (v1)

1. **Recruitment / ATS** — onboarding starts from "candidate accepted offer"; sourcing and applicant tracking is a separate future initiative.
2. **Performance management, training/LMS, succession planning** — not needed for the core attendance→payroll compliance loop; deferred to v2+.
3. **Multi-country payroll** — Thailand only. The statutory rules engine is designed to be country-pluggable (P2) but no other country ships in v1.
4. **Native mobile apps** — v1 ships a responsive PWA (camera access for face clock-in works in modern mobile browsers). Native iOS/Android apps are a fast-follow once the API surface is stable.
5. **Government e-filing integration** — v1 generates compliant export files (SSO, PND 1, bank transfer); it does not transmit directly to SSO e-Service or RD e-Filing APIs. Direct submission is P2.
6. **Managed cloud SaaS offering** — v1 targets self-hosted deployment; multi-tenant SaaS hosting is a business decision for later.

## 4. Users and Personas

| Persona | Description | Primary modules |
|---|---|---|
| **Employee (ESS)** | Rank-and-file staff, factory or office; Thai, English, or Mandarin speaking; uses a phone | Face clock-in, leave requests, claims, payslips, timesheet view |
| **Line Manager** | Approves leave/claims/OT; owns shift roster for their team | Scheduler, approvals, team timesheets |
| **HR Officer** | Runs onboarding, maintains employee records, manages leave policies | Onboarding, leave, scheduler, timesheet corrections |
| **Payroll Officer** | Runs payroll, files SSO/tax, produces bank files | Payroll, timesheet lock, statutory reports |
| **HR Admin / System Admin** | Configures statutory rules, RBAC roles, org structure, languages | All configuration, audit logs |
| **Data Protection Officer (DPO)** | Manages consent records, data-subject requests, retention | Compliance console, audit logs |
| **Auditor (read-only)** | External accountant or labour inspector support role | Reports, audit trail (scoped, read-only) |

## 5. Scope — Module Overview

v1 ships seven functional modules as independent microservices, plus platform services. Delivery order follows the dependency chain:

```
Onboarding → Scheduler → Timesheet ← Facial Attendance
                              ↓
                    Leave ──→ Payroll ←── Claims
```

| # | Module | One-line scope |
|---|---|---|
| M1 | HR Onboarding | Employee master data, contracts, document collection, probation tracking, PDPA consent capture |
| M2 | Scheduler | Shift patterns, rosters, public-holiday calendar, OT pre-approval |
| M3 | Timesheet | Consolidated actual-vs-scheduled time, OT calculation, lateness/absence, period locking |
| M4 | Facial Recognition Attendance | Enrolment, liveness-checked face clock-in/out (kiosk + mobile PWA), events pushed to Timesheet |
| M5 | Leave | Statutory + company leave types, balances/accruals, multi-level approval, calendar integration |
| M6 | Claims | Expense claim types, receipts, approval chains, payroll or off-cycle reimbursement |
| M7 | Payroll | Gross-to-net (Thai PIT, SSO, EWF, provident fund), payslips, bank files, statutory exports |

---

## 6. Functional Requirements by Module

Requirements use P0 (must-have, v1 cannot ship without), P1 (nice-to-have, fast follow), P2 (future consideration — design for, don't build). Acceptance criteria (AC) are summarised here; the full per-module test documents (Stage 4) expand every AC into test cases.

### M1 — HR Onboarding

**P0**
- **M1-1 Employee master record.** Create/maintain employee profiles: Thai + English (+ optional Chinese) name, national ID/passport, tax ID, SSO number, bank account, address (Thai format), emergency contact, employment type (monthly/daily/hourly/contract), department, position, start date, probation end date.
  - AC: national ID validated by Thai 13-digit checksum; sensitive fields (national ID, bank account) stored only via the encryption service; duplicate national ID blocked.
- **M1-2 Guided onboarding workflow.** Configurable checklist per employee type: offer data → personal data collection (via self-service link) → document upload (ID card, house registration, bank book, certificates) → contract generation → PDPA consent capture → SSO registration reminder (within 30 days of start, per SSA) → probation review dates.
  - AC: Given a new hire with start date D, when onboarding is initiated, then an SSO-registration task with deadline D+30 is auto-created and escalates if incomplete at D+23.
- **M1-3 PDPA consent capture at onboarding.** Versioned consent forms (general HR processing notice + separate explicit consent for biometric enrolment) in the employee's chosen language; consent state recorded per purpose; biometric consent refusable without blocking employment (see PDPA doc §5).
  - AC: an employee who declines biometric consent completes onboarding and is auto-flagged for the alternative clock-in method.
- **M1-4 Contract & document generation.** Generate employment contracts and standard letters from trilingual templates with merge fields; store signed copies against the employee record.
- **M1-5 Probation tracking.** Probation end alerts to manager and HR at −14 and −7 days; confirm/extend/terminate outcomes recorded (termination during probation still checks the ≥120-day severance rule — see Statutory Spec §7).

**P1**
- M1-6 Employee self-service data-change requests with HR approval.
- M1-7 Bulk import (CSV/XLSX) for initial migration with validation report.
- M1-8 Work-permit and visa expiry tracking for foreign employees (alerts at −90/−60/−30 days).

**P2**
- M1-9 Offboarding workflow (asset return, final pay trigger, PDPA retention clock start).
- M1-10 e-Signature integration.

### M2 — Scheduler

**P0**
- **M2-1 Shift definitions.** Named shifts with start/end, break rules, grace periods, night-shift crossing midnight, and shift differentials (flat or %).
- **M2-2 Roster planning.** Assign shifts to employees/teams by day/week/month; copy patterns; conflict detection (double-booking, leave collisions).
  - AC: Given an approved leave on date D, when a manager rosters that employee on D, then the system warns and requires override with reason.
- **M2-3 Thai public-holiday calendar.** Ships with the ≥13 statutory public holidays (incl. National Labour Day, 1 May); company can add holidays but cannot reduce below 13; substitute-holiday auto-generation when a holiday falls on a rest day.
- **M2-4 Working-time guardrails.** Warn/block per statutory limits: >8 regular hours/day, >48 hours/week (42 for hazardous-work flag), OT >36 hours/week (see Statutory Spec §4).
- **M2-5 OT pre-approval workflow.** Manager (or employee-request) OT with hours, reason, and rate class; approved OT feeds the timesheet OT allowance.

**P1**
- M2-6 Shift-swap requests between employees with manager approval.
- M2-7 Auto-rostering suggestions from demand templates.

**P2**
- M2-8 Labour-cost forecasting from roster × pay rates.

### M3 — Timesheet

**P0**
- **M3-1 Consolidation.** For each employee-day, merge scheduled shift (M2), attendance events (M4 or manual/alternative punches), and approved leave (M5) into a daily record: actual in/out, worked hours, late minutes, early-leave, absence, OT (approved vs worked).
- **M3-2 OT computation.** Classify OT into statutory rate classes — workday OT (1.5×), holiday work (1× additional for monthly staff entitled to paid holidays / 2× for daily-rate), holiday OT (3×) — using hourly base = monthly wage ÷ 30 ÷ 8 by default (configurable, floor-validated). See Statutory Spec §4.
  - AC: worked OT without pre-approval is flagged for manager regularisation, not silently paid or silently dropped.
- **M3-3 Exception management.** Missed-punch, late, and absence exceptions queue to manager/HR with correction workflow; every manual correction stores who/when/why (immutable audit).
- **M3-4 Period locking.** HR locks a timesheet period before payroll pull; post-lock corrections require Payroll-Officer-approved unlock and are version-stamped.
  - AC: Given a locked period, when Payroll runs, then the run references the lock version; any later unlock forces a payroll variance report.
- **M3-5 Timesheet views.** Employee sees own timesheet; manager sees team; HR sees org — all scoped by RBAC data rules.

**P1**
- M3-6 Geofence validation for mobile punches (GPS radius per work site).
- M3-7 Configurable rounding rules (e.g., 15-minute) with statutory-fairness guard (rounding may not systematically favour employer).

**P2**
- M3-8 Project/cost-centre time allocation.

### M4 — Facial Recognition Attendance

**P0**
- **M4-1 Enrolment.** Capture face template only after explicit PDPA biometric consent (M1-3); guided multi-angle capture; template stored as an encrypted embedding vector — raw enrolment images deleted after template creation (configurable grace ≤7 days for QA).
- **M4-2 Clock-in/out.** Kiosk mode (fixed tablet at site entrance) and mobile PWA mode; 1:N match for kiosk, 1:1 verify for mobile (user logs in, face verifies); target ≤2 s recognition, false-accept rate ≤0.1% at configured threshold.
- **M4-3 Liveness detection.** Active or passive liveness to defeat photo/video replay ("buddy punching"); failed liveness logs a security event.
- **M4-4 Event pipeline to Timesheet.** Every accepted punch publishes an attendance event (employee, timestamp, site, device, direction in/out, match score) to the message broker; Timesheet consumes idempotently.
  - AC: Given broker downtime, when a kiosk accepts punches, then events queue locally and deliver on reconnect with no loss or duplication (at-least-once + idempotency key).
- **M4-5 Alternative clock-in method.** PIN/QR/badge punch for employees without biometric consent, failed matches, or device issues — identical downstream event format so Timesheet is method-agnostic.
- **M4-6 Offline tolerance (kiosk).** Kiosk continues capturing punches ≥24 h without server connectivity.
- **M4-7 Self-hosted engine.** Face engine runs as a container in the same Docker Compose (e.g., CompreFace/InsightFace-based service); no face data leaves the deployment.

**P1**
- M4-8 Re-enrolment prompts on repeated low-score matches (appearance change).
- M4-9 Anti-tailgating multi-face handling on kiosk (log all, punch only the confirmed match).

**P2**
- M4-10 Thermal/mask-tolerant models; hardware access-control (door relay) integration.

### M5 — Leave

**P0**
- **M5-1 Statutory leave types shipped as defaults** (full table in Statutory Spec §3): annual (6 days after 1 year of service), sick (30 paid days/yr; medical certificate demandable at ≥3 consecutive days), personal/business (3 paid days), maternity (120 days per LPA No. 9, effective 7 Dec 2025), paternity/spousal childbirth (15 days full pay), infant-care (15 days at 50% pay), sterilization, military service, plus public holidays and weekly rest.
  - AC: HR can raise any entitlement or add company leave types; lowering a statutory type below the floor is blocked with the citation shown.
- **M5-2 Accrual & balance engine.** Per-type accrual (annual grant, monthly accrual, or service-anniversary), pro-ration for new joiners, carry-over rules (statutory: unused annual leave is carried/paid — Supreme Court position — default carry-over ON), payout-on-termination calculation feeding Payroll.
- **M5-3 Request & approval workflow.** Employee applies (half-day and hourly supported where policy allows) with attachments (medical certs); multi-level approval chains by leave type/duration; delegation for absent approvers.
- **M5-4 Timesheet & scheduler integration.** Approved leave writes to Timesheet as paid/unpaid per type and blocks rostering (M2-2).
- **M5-5 Balances in ESS.** Employee sees balances, accrual history, and projected balance at a future date, in their language.

**P1**
- M5-6 Team leave calendar with concurrency limits (max N absent per team/day).
- M5-7 Leave encashment requests (where company policy allows).

**P2**
- M5-8 LINE notification/approval integration (Thailand-standard channel).

### M6 — Claims

**P0**
- **M6-1 Claim types & policies.** Configurable types (travel, meal, medical, per-diem, mileage) with per-type limits (per-claim, monthly, annual), required fields, and receipt requirements.
- **M6-2 Submission.** ESS submission with receipt photo/PDF upload; mileage claims from distance × configurable rate; VAT field for tax-deductible expense reporting.
- **M6-3 Approval chain.** Amount-banded multi-level approval (e.g., ≤2,000 THB manager only; >2,000 THB manager + finance); rejection with reason; resubmission.
- **M6-4 Reimbursement routing.** Approved claims marked for next payroll run (non-taxable reimbursement line, kept out of tax/SSO wage base) or off-cycle bank-file payment; status visible to employee end-to-end.
- **M6-5 Budget/limit enforcement.** Hard/soft limit behaviour per type; duplicate-receipt detection (same amount+date+vendor hash).

**P1**
- M6-6 OCR receipt extraction (amount, date, vendor) with human confirmation.
- M6-7 Cash advance requests with claim offsetting.

**P2**
- M6-8 Corporate card feed reconciliation.

### M7 — Payroll

**P0**
- **M7-1 Pay structures.** Monthly, daily, and hourly pay bases; recurring earnings/deductions (allowances, shift differentials from M2, position allowance); one-off items; minimum-wage floor validation against the employee's province (Statutory Spec §8).
- **M7-2 Gross-to-net engine (Thailand).** In statutory order: gross earnings (base + OT from locked timesheets + taxable allowances) → SSO employee 5% of capped wage (ceiling per Statutory Spec §5 — 2026 ceiling raised 1 Jan 2026; employer matches) → Employee Welfare Fund 0.25% employee + 0.25% employer from 1 Oct 2026 for employers without a registered provident fund → provident fund (2–15% voluntary) → withholding tax via annualised PIT method with employee allowance declarations (ล.ย.01 equivalent) → net pay. All rates/brackets come from the versioned statutory config, never hard-coded.
  - AC: Given the 1 Oct 2026 EWF effective date, a payroll run for September 2026 applies no EWF and a run for October 2026 applies 0.25% — with no software update, only effective-dated config.
- **M7-3 Payroll run lifecycle.** Draft → calculate → variance review (vs previous period, threshold-flagged) → approve (segregation of duties: preparer ≠ approver) → commit → payment. Committed runs are immutable; corrections happen via off-cycle/adjustment runs.
- **M7-4 Payslips.** PDF + in-app e-payslips in the employee's language (Thai payslips show Buddhist Era dates), itemising earnings, deductions, employer contributions, and YTD figures; access-controlled and encrypted at rest.
- **M7-5 Bank transfer file.** Configurable Thai bank payroll file formats (at minimum a generic CSV template + 2 major-bank templates) for net pay disbursement.
- **M7-6 Statutory outputs.** Monthly: SSO contribution report (สปส.1-10 data layout) and PND 1 withholding data export; annual: PND 1 Kor summary data, 50 bis withholding certificates per employee, and Kor Ror 11 employment-conditions report data pack (submission itself is manual in v1 — see Non-Goal 5).
- **M7-7 Termination pay.** Final-pay calculator: outstanding wages, unused-leave payout (M5-2), severance per Section 118 tiers (30/90/180/240/300/400 days by service length), pay in lieu of notice; all itemised and auditable.

**P1**
- M7-8 Retro-pay engine for backdated changes.
- M7-9 Provident fund file exports for common fund managers.
- M7-10 GL journal export (configurable account mapping).

**P2**
- M7-11 Direct SSO e-Service / RD e-Filing API submission.
- M7-12 Multi-entity consolidated payroll.

---

## 7. Cross-Cutting Requirements

### 7.1 Security, Encryption & RBAC (P0)

- **Field-level encryption before DB write.** A dedicated crypto/KMS service performs envelope encryption (per-record data keys wrapped by master keys in a key manager, e.g., Vault container). Classified-sensitive fields (biometric templates, national ID, bank accounts, salaries, health data) are encrypted by the owning service **before** any INSERT/UPDATE; the database never receives plaintext for these fields. Searchable sensitive fields use blind indexes (HMAC) — no plaintext search columns. Key rotation without downtime; key access fully audited. (Full design: Stage 2 Security Architecture doc.)
- **RBAC, deny-by-default.** Central identity service (OIDC) issues tokens; every API route requires an explicit permission. Roles ship as templates (per §4 personas) and are customisable; **data scoping** restricts rows by org unit/team (a manager sees only their team). **Segregation of duties** enforced in payroll (M7-3) and statutory-config amendments (Statutory Spec §10). All privileged actions write to an append-only audit log.
- **Transport & at-rest baseline.** TLS everywhere (including service-to-service), encrypted volumes/backups, secrets never in images or env files committed to the repo.

### 7.2 Internationalisation (P0)

- Full UI, notifications, generated documents (contracts, payslips, letters) in **Thai (th-TH), English (en), Simplified Chinese (zh-CN)**; per-user language preference; per-document language override.
- **Buddhist Era ↔ Gregorian**: all dates stored as ISO-8601 Gregorian; Thai-locale rendering shows B.E. (พ.ศ. = C.E. + 543); date inputs accept both on Thai locale.
- Thai-specific handling: name order and honorifics, Thai address structure (sub-district/district/province), Thai/Latin sorting, THB formatting, and font support incl. PDF embedding for Thai and CJK glyphs.
- Translation keys externalised; no hard-coded strings; missing-key fallback to English with logging.

### 7.3 Architecture & Deployment (P0)

- **Microservices, one service per module** (M1–M7) plus platform services: API gateway, identity/RBAC, crypto/KMS, notification, document/report, i18n/config, audit. Database-per-service (logical separation at minimum); inter-service events over a message broker; synchronous calls only via the gateway/service APIs.
- **Docker Compose is the complete deployment.** One `docker-compose.yml` (with env-specific overrides) starts the entire system on a single host — no Kubernetes, no external cloud dependencies. Includes: services, PostgreSQL, broker (e.g., RabbitMQ/Redpanda), face engine, key manager, reverse proxy, and observability stack.
- Backup/restore scripts, health checks on every container, structured logs, and metrics endpoints. (Full detail: Stage 2 architecture docs + Stage 5 runbook.)

### 7.4 Statutory Compliance Engine (P0)

- Every Thai statutory value lives in the versioned, **effective-dated** rules configuration defined in the Statutory Rules Spec — never in code.
- **Amendable with governance**: HR Admin proposes a change → statutory-floor validation → second-person approval → effective-dated activation → immutable audit trail. Values below statutory minimums are rejected with the legal citation.
- Rule packs are shippable as updates (e.g., a 2027 tax-bracket pack) applied as data, not code deployments.

### 7.5 Non-Functional Requirements

| Area | Requirement |
|---|---|
| Capacity | 1,000 active employees per deployment; 200 concurrent users; 10 punch events/sec burst |
| Performance | API p95 < 500 ms; face match ≤ 2 s end-to-end; monthly payroll for 1,000 employees < 10 min |
| Availability | Single-host target 99.5%; kiosk offline tolerance 24 h; RPO ≤ 24 h (daily backup default), RTO ≤ 4 h |
| Auditability | Append-only audit log for all writes to employee, time, pay, and config data; 100% coverage of privileged actions |
| Data protection | PDPA-aligned retention & deletion schedules per data class (see PDPA doc §7); DSAR fulfilment tooling |
| Browser support | Evergreen Chrome/Edge/Safari; Android/iOS mobile browsers with camera API for PWA face clock-in |

---

## 8. Competitive Reference

| Capability | EzyHR (TH) | Typical TH market (TigerSoft, B-Plus, Prosoft, Humanica) | GaDongHR v1 |
|---|---|---|---|
| Mobile clock-in/out | Yes (mobile app, anywhere) | GPS/selfie common; face on premium tiers | Face + liveness, kiosk & PWA, self-hosted engine |
| Multi-level request workflows | Yes | Yes | Yes, incl. OT pre-approval and amount-banded claims |
| Thai payroll compliance | Yes | Core strength (SSO, PND 1 exports) | Yes, as amendable effective-dated config with floors |
| Languages | Thai/English typical | Thai/English typical | **Thai/English/Mandarin** |
| Self-hosting | No (SaaS) | Mostly SaaS/on-prem legacy | **Docker Compose, fully self-hosted** |
| Field-level encryption transparency | Opaque | Opaque | **Documented encrypt-before-write + customer-held keys** |
| LINE integration | Common in market | Common | P2 (deliberate fast-follow) |

Differentiators to protect in scope decisions: self-hosting, encryption transparency, Mandarin, and statutory-rules governance. Parity items not to gold-plate in v1: generic workflow builder, analytics dashboards.

## 9. Success Metrics

**Leading (first 60 days of a deployment)**
- Install success: fresh `docker compose` deployment completes < 60 min (measured via install telemetry opt-in / pilot observation).
- Attendance adoption: ≥ 90% of active employees enrolled (face or alternative method) by day 30.
- Punch-to-timesheet integrity: ≥ 99.9% of punch events reflected in timesheets; 0 lost events.
- Face performance: median match < 2 s; false-accept ≤ 0.1%; liveness-block events reviewed weekly.
- Payroll accuracy: first parallel-run variance vs incumbent process ≤ 0.5% of net pay lines; second run 0 unexplained variances.

**Lagging (quarterly)**
- ≥ 95% of pay periods closed without post-lock timesheet corrections.
- 0 statutory-floor violations shipped in any tenant's active config.
- DSAR (data subject access request) fulfilment ≤ 30 days, 100% of requests.
- Pilot customer retention ≥ 90% at 12 months; support tickets per 100 employees trending down month-over-month.

## 10. Open Questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| Q1 | Target company size band for v1 defaults (50–200 vs 200–1,000) — affects approval-chain depth and payroll performance targets | Product owner | No (defaults assume 50–500; confirm) |
| Q2 | Face engine selection: CompreFace vs custom InsightFace service — accuracy on Thai/Chinese faces, licence, GPU vs CPU-only hosts | Engineering | Yes, before M4 build |
| Q3 | Which two Thai bank payroll file formats ship in v1 (candidate: KBank, SCB, BBL, Krungsri) | Product + pilot customer | No |
| Q4 | 2026 SSO wage-ceiling exact figure and transition rules — confirm against Royal Gazette before payroll defaults finalised | Legal/Compliance | Yes, before M7 config freeze |
| Q5 | Pending LPA draft amendments (first reading passed Sept 2025: working-hours/annual-leave changes) — monitor; rules engine must absorb via config | Legal/Compliance | No (design absorbs) |
| Q6 | Is a DPO legally required for target customers (core-activity large-scale sensitive processing likely YES given biometrics) — affects onboarding wizard defaults | Legal/Compliance | No |
| Q7 | Payslip signature/company-seal requirements per customer practice | Pilot customer | No |

## 11. Timeline & Phasing

Hard external dates the product must absorb (config, not code): **1 Oct 2026** EWF contributions begin; **1 Jan 2027** likely tax/SSO annual updates; LPA No. 9 entitlements already in force since 7 Dec 2025.

Suggested build phases (each phase ships usable value):

| Phase | Contents | Exit criteria |
|---|---|---|
| A — Platform + M1 | Gateway, identity/RBAC, crypto/KMS, i18n, audit, Onboarding | New hire fully onboarded with consents; RBAC + encryption proven by security review |
| B — Time capture | M2 Scheduler, M4 Attendance, M3 Timesheet | 30-day pilot: punches→timesheet ≥99.9% integrity |
| C — Requests | M5 Leave, M6 Claims | Statutory leave defaults pass compliance review; approvals in 3 languages |
| D — Payroll | M7 + statutory exports | Two clean parallel payroll runs vs incumbent |
| E — Hardening | Pen test, PDPA audit, load test, docs | Security & compliance sign-off |

---

*Review checkpoints: after stakeholder review of this PRD, Stage 2 (architecture document set) proceeds. Statutory figures cited here are summaries — the authoritative, effective-dated values with citations live in the Statutory Rules Specification and must be re-verified against the Royal Gazette / SSO / Revenue Department before go-live (see that doc's verification log).*
