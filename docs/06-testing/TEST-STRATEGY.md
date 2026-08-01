# GaDongHR — Test Strategy (Stage 4)

| Field | Value |
|---|---|
| Version | 0.1 (Draft) · Date 2026-08-02 |
| Scope | All modules M1–M7 + platform (authz, crypto, config, audit, i18n) |
| Companion docs | `M1…M7-TESTS.md`, `UAT-PLAN.md`, `TRACEABILITY-MATRIX.md` |

## 1. Test Levels & Ownership

| Level | Scope | Tooling | Gate |
|---|---|---|---|
| Unit | Domain engines (OT classifier, gross-to-net, accrual, severance, guardrails, crypto client) | Jest + ts fixtures | ≥85% line cov on engine packages; 100% branch cov on GrossToNetEngine & OtClassifier |
| Integration (per service) | API + DB schema + outbox, against real Postgres/RabbitMQ in compose test profile | Jest + testcontainers-style compose | All module test docs' API cases green |
| Contract | Event schemas (`gadong.events`) and OpenAPI between services | JSON-schema registry + generated consumer tests | Breaking change fails CI |
| End-to-end | Cross-service flows: punch→timesheet→payroll; onboarding→consent→enrolment; leave→timesheet→payroll | Playwright (PWA) + API orchestration | E2E suite green on release candidate |
| Security | RBAC matrix, encryption-at-rest verification, liveness bypass, SoD, audit chain | Custom RBAC generator + pen-test (external) | Security doc §8 checklist complete |
| Performance | Punch burst 10/s · payroll 1,000 emp <10 min · API p95 <500 ms · face match ≤2 s | k6 + engine benchmark | PRD §7.5 targets met |
| i18n | th/en/zh rendering, B.E. dates, PDF fonts, missing-key fallback | Snapshot + visual diff | Zero hard-coded strings; zh/th payslip PDFs pixel-checked |
| Statutory regression | Golden-file payroll fixtures per rule-pack version | Fixture runner | Any rule-pack update must pass old+new effective-date suites |
| UAT / Parallel run | Pilot customer scenarios + 2 parallel payroll cycles | UAT-PLAN.md | ≤0.5% variance run 1, 0 unexplained run 2 |

## 2. Test Environment
`docker compose --profile core --profile test up`: full stack + seeded fixture tenant (see §3) + mailhog (SMTP capture) + fixed clock service (time-travel for effective-date tests). Faces: consented synthetic face dataset for enrolment/match tests (no real employee biometrics in test data — PDPA).

## 3. Canonical Fixture Tenant ("Siam Test Co., Ltd.")
- 3 org units (Bangkok office, Chonburi plant hazardous-flag, Sales), provinces with different minimum wages.
- 25 employees covering: monthly/daily/hourly; Thai/English/Chinese preferred languages; biometric-consented and refused; probation; hire dates straddling 7 Dec 2025 and 1 Oct 2026; provident-fund member and non-member; tenure bands 119d/121d/2.9y/3.1y/9y/21y (severance tiers); salary at SSO ceiling boundary.
- 12 months of punches, rosters, leave, claims generating every OT class and exception type.
- Statutory rule packs at three effective windows: pre-Dec-2025, Dec-2025→Sep-2026, Oct-2026+.

## 4. Entry / Exit Criteria per Module
Entry: module API implements its Stage 3 manual; migrations apply cleanly; contract schemas registered. Exit: all P0 test cases pass; no Sev-1/Sev-2 open; security cases for the module pass; i18n snapshot green; traceability row complete.

## 5. Defect Severity
Sev-1 wrong pay/statutory output, data exposure, lost punches · Sev-2 blocked P0 workflow · Sev-3 P1 feature/UX · Sev-4 cosmetic. Sev-1 in payroll/crypto = release blocker + root-cause note in ADR log.

## 6. Cross-Cutting Suites (apply to every module)
- **XC-RBAC**: generated matrix — every role × every endpoint from API manuals; expect exact allow/deny; "no human role reads biometric templates" asserted globally.
- **XC-CRYPTO**: for each 🔐 column, raw SQL dump contains no fixture plaintext; AAD-swap of two employees' ciphertext fails decryption; Vault sealed ⇒ S3 writes 503, no plaintext fallback; crypto-erasure renders record unreadable.
- **XC-EVENTS**: duplicate delivery ×3 of every event type ⇒ single effect; outbox survives kill -9 between DB commit and publish.
- **XC-AUDIT**: every write & S3 read produces chained entry; chain verification detects a tampered row.
- **XC-I18N**: UI + notifications + PDFs in th/en/zh; Thai payslip shows พ.ศ. dates; zh renders CJK in PDF; missing key logs + falls back to en.
