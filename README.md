# GaDongHR

Self-hosted Thailand HRMS — microservices, Docker Compose, field-level encryption, RBAC, trilingual (ไทย / English / 中文).

**Modules (v1):** HR Onboarding · Scheduler · Timesheet · Facial-Recognition Attendance · Claims · Leave · Payroll

## Documentation Index

| Stage | Document | Path | Status |
|---|---|---|---|
| 1 | Product Requirements Document (PRD) | `docs/01-product/PRD.md` | ✅ Draft 0.1 |
| 1 | Thailand Statutory Rules Configuration Spec | `docs/02-statutory/THAILAND-STATUTORY-RULES-SPEC.md` | ✅ Draft 0.1 |
| 1 | PDPA Compliance & Biometric Consent | `docs/03-compliance/PDPA-BIOMETRIC-COMPLIANCE.md` | ✅ Draft 0.1 |
| 2 | Architecture Overview (services, diagrams, stack) | `docs/04-architecture/ARCHITECTURE-OVERVIEW.md` | ✅ Draft 0.1 |
| 2 | Database Design (ERDs, data flows, retention) | `docs/04-architecture/DATABASE-DESIGN.md` | ✅ Draft 0.1 |
| 2 | Security, Encryption & RBAC Design | `docs/04-architecture/SECURITY-ENCRYPTION-DESIGN.md` | ✅ Draft 0.1 |
| 2 | Architecture Decision Records (ADR-001…008) | `docs/04-architecture/adr/` | ✅ Draft 0.1 |
| 2 | Docker Compose skeleton + env template | `deploy/docker-compose.yml`, `deploy/.env.example` | ✅ Draft 0.1 |
| 3a | Module design: M1 Onboarding · M2 Scheduler · M3 Timesheet · M4 Attendance (workflows, class diagrams, API manuals) | `docs/05-modules/M1…M4` | ✅ Draft 0.1 |
| 3b | Module design: M5 Leave · M6 Claims · M7 Payroll | `docs/05-modules/M5…M7` | ✅ Draft 0.1 |
| 4 | Test Strategy · per-module test docs (M1…M7) · UAT plan & parallel-run protocol · Traceability matrix | `docs/06-testing/` | ✅ Draft 0.1 |
| 5 | Operations Runbook (install, Vault ceremony, backup/restore, incidents) | `docs/07-operations/OPERATIONS-RUNBOOK.md` | ✅ Draft 0.1 |
| 5 | i18n Guide + th/en/zh HR Glossary | `docs/07-operations/I18N-GUIDE.md` | ✅ Draft 0.1 |
| 5 | Seed / Master Data Specification | `docs/07-operations/SEED-DATA-SPEC.md` | ✅ Draft 0.1 |

## Pushing this docset to GitHub

From the folder containing this README:

```bash
git init
git remote add origin https://github.com/Mavrone81/GaDongHR.git
git checkout -b main   # or: git pull origin main if the repo already has commits
git add .
git commit -m "docs: Stage 1 — PRD, Thailand statutory rules spec, PDPA biometric compliance"
git push -u origin main
```

## Important caveats

- Statutory figures are **effective-dated defaults with citations**; items in the Statutory Spec §12 Verification Log must be confirmed against the Royal Gazette / SSO / Revenue Department before go-live.
- Compliance documents are engineering artefacts, **not legal advice** — obtain Thai counsel review (labour + PDPA) before production deployment.
