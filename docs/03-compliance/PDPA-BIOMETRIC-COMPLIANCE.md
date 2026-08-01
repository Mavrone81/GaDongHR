# GaDongHR — PDPA Compliance & Biometric Consent Management

| Field | Value |
|---|---|
| Version | 0.1 (Draft) |
| Date | 2026-08-01 |
| Governing law | Personal Data Protection Act B.E. 2562 (2019), fully effective 1 June 2022, and PDPC sub-regulations |
| Status | Stage 1 deliverable — requires Thai counsel review before production |

## 1. Why This Document Exists

GaDongHR processes the highest-risk category of employee data: **biometric facial templates**, which are *sensitive personal data* under **PDPA Section 26**, alongside national ID numbers, health data (sick-leave certificates), salaries, and bank details. Non-compliance exposes the deploying employer (the **data controller**) to administrative fines up to **5,000,000 THB** for sensitive-data violations, criminal liability (imprisonment up to 1 year and/or fines) for unlawful sensitive-data use, and punitive damages up to 2× actual damages in civil claims. This document defines the roles, lawful bases, consent design, technical measures, and operational duties the product must implement and the customer must operate.

## 2. Roles

| Party | PDPA role |
|---|---|
| Deploying company (the employer) | **Data controller** |
| GaDongHR (self-hosted software) | Tooling operated by the controller; if the vendor hosts or supports with data access, vendor = **data processor** requiring a Data Processing Agreement (DPA template to ship in Stage 5) |
| Employees, dependants, emergency contacts | **Data subjects** |

**DPO:** PDPA requires a Data Protection Officer where core activities involve large-scale processing of sensitive data. Systematic biometric attendance across a workforce very likely meets this test — the product defaults to "DPO required = YES" in the compliance setup wizard, with the DPO's contact published in the privacy notice.

## 3. Data Inventory & Lawful Bases (ROPA seed)

The system ships a pre-populated **Record of Processing Activities** the controller confirms during setup:

| Data class | Examples | Sensitivity | Default lawful basis |
|---|---|---|---|
| Identity & contact | Name, address, phone, photo | Personal | Contract (s.24(3)) |
| National ID / passport | 13-digit ID | High-risk personal | Legal obligation (tax/SSO filings) |
| Employment & payroll | Salary, bank account, tax, SSO number | Personal | Contract + legal obligation |
| Health | Sick-leave medical certificates | **Sensitive (s.26)** | Legal-obligation exemptions for labour-law compliance (s.26(5)(b)-aligned); minimise: store cert, not diagnosis, where possible |
| **Biometric** | Face templates (embeddings), enrolment images | **Sensitive (s.26)** | **Explicit consent — no exemption reliably applies** |
| Attendance & location | Punch times, kiosk/site, optional GPS | Personal | Legitimate interest / contract, with notice |
| Union/religious data | Only if voluntarily provided (e.g., ordination leave) | Sensitive | Explicit consent; avoid collecting by default |

## 4. Biometric Consent Design (Section 26: explicit consent)

Requirements the product enforces:

1. **Explicit, informed, prior.** Enrolment (M4-1) is technically impossible until the employee has been shown (in their chosen language — Thai/English/Mandarin) and affirmatively accepted a **dedicated biometric consent**, separate from the general HR privacy notice and the employment contract. The notice states: what is collected (face template), purpose (attendance only), retention, who can access, that raw images are deleted after template creation, and how to withdraw.
2. **Freely given — the employment-context problem.** Consent obtained under pressure is invalid. Therefore the system **always offers an equivalent alternative clock-in method** (PIN/QR/badge — PRD M4-5), refusal is recorded without any adverse-flag field existing in the schema, and consent screens state refusal has no employment consequence. This is the single most important design control making employee biometric consent defensible.
3. **Versioned & auditable.** Consent records store: form version, language shown, timestamp, method (ESS click-through with authentication), and full text as-shown. Re-consent is triggered when the form materially changes or purposes expand.
4. **Withdrawal as easy as giving.** One-tap withdrawal in ESS → face template hard-deleted within a defined SLA (default 7 days, configurable down), employee auto-switched to the alternative method, withdrawal confirmed in-app. Historical *punch records* (non-biometric facts: who/when/where) are retained under labour-law retention — only the biometric template is destroyed.
5. **Purpose limitation.** Face templates are usable by exactly one service (attendance matching). No API exposes raw templates; no secondary use (e.g., photo directory, surveillance) without a new consent purpose.
6. **Minors/special cases.** If any employee is under 20 with guardian-consent nuances (rare; Thai labour min age 15), the wizard flags guardian-consent handling.

## 5. Technical & Organisational Security Measures

Mapped to PDPC minimum security standards (confidentiality, integrity, availability; access control; awareness):

| Measure | Product implementation |
|---|---|
| Encrypt-before-write | All s.26 sensitive fields + national ID, bank, salary encrypted at application layer (envelope encryption; keys in Vault container) before any DB insert. DB dumps reveal no plaintext sensitive data. Face templates additionally bound to employee ID via AEAD associated data to prevent template swapping |
| Raw-image handling | Enrolment images deleted on template creation (≤7-day QA grace, configurable to 0); clock-in frames processed in memory, never persisted on success; failed-liveness frames retained encrypted for security review ≤30 days |
| Access control | Deny-by-default RBAC; biometric data readable by no human role — even System Admin sees existence/status only. Payroll data scoped by segregation-of-duties |
| Audit | Append-only log of every access to sensitive data classes (who, what, when, purpose route); tamper-evident (hash-chained) |
| Transport | TLS on all external and inter-service traffic |
| Availability | Encrypted backups; documented restore; key-loss = data-loss warning and key-backup ceremony in runbook |
| Breach response | Incident console: detect → assess → **notify PDPC within 72 hours** where risk to data subjects; notify subjects without undue delay if high risk; breach register maintained in-product |
| Awareness | Admin onboarding includes PDPA duty acknowledgements; annual re-attestation task |

## 6. Data Subject Rights (DSR) Tooling

The DPO console implements each PDPA right with workflow + SLA tracking (default response ≤ 30 days):

| Right | Product behaviour |
|---|---|
| Access / copy (s.30) | One-click export of an employee's data across all services (machine-readable + human PDF) |
| Rectification (s.35–36) | Correction workflow with audit trail |
| Erasure (s.33) | Eligibility check against retention holds (labour/tax law overrides — engine explains which law blocks which record and until when); everything else hard-deleted; certificate of deletion issued |
| Restriction / objection (s.31–32, s.34) | Processing-flag per data class; attendance objection → switch to alternative method |
| Portability (s.31) | Structured export (JSON/CSV) |
| Withdraw consent (s.19) | See §4.4 |
| Complaint routing | DPO contact + PDPC complaint info in privacy notice |

## 7. Retention & Deletion Schedule (defaults, editable ≥ legal minimums)

| Data | Retention default | Legal driver |
|---|---|---|
| Face template | Employment duration only → deleted ≤7 days after termination or consent withdrawal | PDPA minimisation |
| Enrolment raw images | 0–7 days | PDPA minimisation |
| Punch/attendance records | 2 years after termination | LPA working-time/wage records (s.114–115: ≥2 years) |
| Employee register & wage/OT payment docs | 2 years after termination | LPA s.112, s.115 |
| Payroll & tax records (PND, 50 bis) | 5 years | Revenue Code |
| Accounting-relevant payroll journals | 5 years | Accounting Act |
| Sick-leave medical certificates | 2 years after leave year (diagnosis minimised) | LPA records + PDPA minimisation |
| Consent records | Duration of processing + limitation period (default 10 years) | Evidentiary |
| Candidate data never hired | 6 months default | PDPA minimisation |

Deletion is automated: nightly job identifies expired records → DPO review queue → cryptographic erasure (destroy per-record data keys) + physical delete. Conflicts always resolve to the **longest legally required** period, never longer.

## 8. Cross-Border Transfers (s.28)

Default posture: **no transfer** — self-hosted in Thailand, face engine local, no external APIs receive personal data. If a customer hosts abroad or enables vendor support access, the wizard requires selecting a transfer mechanism (adequate country, consent, or appropriate safeguards/BCR) and records it in the ROPA. Mandarin-language processing must not route text through third-country translation APIs containing personal data (translations are static resource files).

## 9. Customer-Facing Compliance Artefacts Shipped with the Product

1. Privacy notice templates (employee, candidate) — th/en/zh
2. Biometric consent form template — th/en/zh (§4 requirements embedded)
3. DPA template (vendor-as-processor scenarios)
4. ROPA pre-populated register (§3)
5. Breach-response playbook + PDPC notification form data
6. DPIA template pre-filled for facial-recognition attendance (high-risk processing — recommend completing before enabling M4 in production)
7. Retention schedule (§7) as active configuration

## 10. Open Compliance Questions

| # | Question | Owner |
|---|---|---|
| C1 | Confirm whether current PDPC notifications add biometric-specific guidance beyond s.26 (guidelines evolve) | Thai counsel |
| C2 | DPIA obligation formalisation status for high-risk processing | Thai counsel |
| C3 | Works-council/union consultation needs for attendance monitoring at unionised sites | Customer HR/legal |
| C4 | Whether vendor remote-support model triggers processor DPA by default | Product + counsel |

> **Disclaimer:** This is a product compliance design document, not legal advice. Deploying employers must obtain their own PDPA counsel review.
