# GaDongHR — Build Program Roadmap

**Decided 2026-08-02:** build all 15 services real and wired (P0 logic; P1/P2 deferred), platform first, then M1→M7 in the PRD's dependency order, deploying after each phase.

**Target host:** `gadonghr-prod` · `157.230.38.96` · sgp1 · 2 vCPU / 4 GB / 80 GB · Bevora DO account. Serves `hr.bevorasg.com` (A record currently still points at 165 — cut over in Phase 1).

---

## Service inventory

Fifteen services plus the frontend. Every one is NestJS on Node 22, owns exactly one Postgres schema, and consumes `@gadong/kernel`.

| # | Service | Schema | Owns | Phase |
|---|---|---|---|---|
| — | `@gadong/kernel` | — | crypto client, outbox, idempotency, authz guard, audit emitter, i18n helper, effective-date resolver | 1 |
| 1 | `svc-crypto` | — | Vault Transit envelope encryption, blind indexes; only Vault client | 1 |
| 2 | `svc-config` | `config` | effective-dated statutory rules, governance workflow, seed packs, feature flags | 1 |
| 3 | `svc-authz` | `authz` | permission catalog, roles, org-scoped grants, SoD checks | 1 |
| 4 | `svc-audit` | `audit` | hash-chained append-only log, chain verification | 1 |
| 5 | `svc-i18n` | — | th/en/zh bundles, fallback, glossary | 1 |
| 6 | `svc-notify` | `notify` | in-app + email, per-recipient language | 1 |
| 7 | `svc-docs` | `docs` | HTML→PDF with Sarabun + Noto Sans SC, B.E. dates, MinIO storage | 1 |
| 8 | `svc-onboarding` | `onboarding` | M1 — employees, documents, consents, probation, checklists | 2 |
| 9 | `svc-scheduler` | `scheduler` | M2 — shifts, rosters, holidays, OT pre-approval | 3 |
| 10 | `svc-attendance` | `attendance` | M4 — enrolment, CompreFace, liveness, punch events | 3 |
| 11 | `svc-timesheet` | `timesheet` | M3 — day records, OT classification, exceptions, period locks | 3 |
| 12 | `svc-leave` | `leave` | M5 — types, accrual, balances, approval chains | 4 |
| 13 | `svc-claims` | `claims` | M6 — types, receipts, banded approval, reimbursement routing | 4 |
| 14 | `svc-payroll` | `payroll` | M7 — pay profiles, gross-to-net, payslips, statutory exports, final pay | 5 |
| 15 | `retention-job` | — | nightly PDPA retention → DPO queue → crypto-erasure | 5 |
| — | `web` | — | React PWA: ESS, manager, admin, DPO, kiosk | 2–5 |

## Phases

| Phase | Plan | Contents | Exit criteria |
|---|---|---|---|
| **1** | `01-foundation-platform.md` | Monorepo, kernel, services 1–7, all 15 service skeletons, CI→GHCR, first deploy | `https://hr.bevorasg.com` live; a field encrypts through Vault and a DB dump shows no plaintext; RBAC denies by default; audit chain verifies |
| **2** | `02-m1-onboarding.md` | M1 Onboarding + PWA shell (ESS/HR) | A new hire is onboarded with separate biometric consent, refusal path works, SSO D+30 task exists |
| **3** | `03-time-capture.md` | M2 Scheduler, M4 Attendance, M3 Timesheet | Punch → timesheet with zero loss across a broker restart; OT classified into 1.5×/2×/3× |
| **4** | `04-requests.md` | M5 Leave, M6 Claims | Statutory leave defaults pass floor validation; banded claim approval in three languages |
| **5** | `05-payroll.md` | M7 Payroll, retention job, statutory exports | Golden-file payroll fixtures pass across all three rule-pack windows; SoD blocks self-approval |
| **6** | `06-hardening.md` | Pen test, PDPA audit, k6 load, restore drill, RBAC matrix generation | Security doc §8 checklist complete |

Each phase's plan is written just before it starts, against the code that then exists. Writing Phase 5's tasks today would guarantee they are wrong.

---

## Contracts every phase depends on

These are fixed in Phase 1 and are the reason 15 services can be built by separate agents without colliding. Changing one is a cross-cutting change, not a local one.

### Event catalog — RabbitMQ topic exchange `gadong.events`

Routing key = event name. Payloads carry **no S3-class plaintext**; a consumer needing a sensitive field fetches it by ID through the owning service's audited API.

| Event | Producer | Payload |
|---|---|---|
| `employee.created` / `employee.updated` | onboarding | `{id, empCode, orgUnitId, employmentType, provinceCode, startDate, status, preferredLang}` |
| `employee.terminated` | onboarding | `{id, terminationDate, reasonCategory}` |
| `consent.granted` / `consent.withdrawn` | onboarding | `{employeeId, purpose, formVersion, at}` |
| `roster.published` | scheduler | `{rosterId, orgUnitId, dateRange, entryCount}` |
| `ot.approved` | scheduler | `{employeeId, otDate, hours, rateClass, approvedBy}` |
| `attendance.punch` | attendance | `{idemKey, employeeId, deviceId, punchedAt, direction, method, siteCode, matchScore, livenessPassed}` |
| `attendance.liveness_failed` | attendance | `{deviceId, at, siteCode}` |
| `timesheet.locked` | timesheet | `{periodId, dateRange, lockVersion, lockedBy}` |
| `timesheet.corrected` | timesheet | `{dayRecordId, employeeId, workDate, correctedBy, reason}` |
| `leave.approved` / `leave.cancelled` | leave | `{requestId, employeeId, leaveTypeCode, dates, days, payMode}` |
| `leave.balance_payout` | leave | `{employeeId, leaveTypeCode, days, reason}` |
| `claim.approved_for_payroll` | claims | `{claimId, employeeId, amountThb, claimType}` |
| `claim.paid_offcycle` | claims | `{claimId, employeeId, paidAt}` |
| `payroll.committed` | payroll | `{runId, period, runType, employeeCount}` |
| `payslip.issued` | payroll | `{payslipId, runId, employeeId, lang}` |
| `rules.updated` | config | `{ruleKeys[], effectiveFrom}` |
| `audit.*` | every service | see audit entry shape below |

**Delivery contract:** producers write to their schema's `outbox` table in the same transaction as the state change; a relay in the kernel publishes. Consumers dedupe on `processed_events(event_id)`. Every consumer must be idempotent — duplicate delivery ×3 produces one effect (XC-EVENTS).

### Permission catalog — `resource.action`

Deny by default. Every route declares exactly one permission. Every grant carries an org scope (`self`, an org-unit subtree, or `*`).

```
employee.create  employee.read  employee.update  employee.lifecycle  employee.import
employee.sensitive.read
onboarding.manage  document.generate  consent.self
roster.read  roster.write  roster.publish  ot.request  ot.approve  holiday.manage
punch.submit  enrolment.manage  device.register  device.approve
timesheet.read  timesheet.correct  timesheet.lock  timesheet.unlock
leave.request  leave.approve  leave.admin  leave.balance.read
claim.submit  claim.approve  claim.approve.finance  claim.admin
payroll.profile.read  payroll.profile.write  payroll.run.prepare  payroll.run.calculate
payroll.run.approve  payroll.run.commit  payroll.export  payslip.read.self  payslip.read.any
config.rule.propose  config.rule.approve  config.pack.import
audit.read  dpo.console  dsr.manage  retention.approve
biometric.template.read
```

**`biometric.template.read` is granted to no human role, ever** — it exists only as a machine grant to `svc-attendance`. Security doc §4.2, asserted globally by XC-RBAC.

**Segregation of duties, enforced in code and by DB constraint:**
- payroll run: `prepared_by ≠ approved_by`
- statutory config: `proposed_by ≠ approved_by`
- timesheet unlock: requires `timesheet.unlock` (Payroll Approver only) + reason, forces a variance report

### Role templates

`employee-ess` · `line-manager` · `hr-officer` · `payroll-officer` · `payroll-approver` · `hr-system-admin` · `compliance-approver` · `dpo` · `auditor-readonly` · `kiosk-device`

### Data classification → storage treatment

| Class | Examples | Treatment |
|---|---|---|
| **S3** | face template refs, national ID, bank account, salary, tax declarations, health attachments | envelope-encrypted `bytea` + blind index if searchable; **every read audited with a purpose** |
| **S2** | names, contacts, address, DOB, punch geo | envelope-encrypted `bytea`; normal RBAC |
| **S1** | rosters, shift definitions, leave types, org units | plaintext; TLS + volume encryption |
| **S0** | i18n bundles, holiday names | no special treatment |

Encrypted columns are `bytea`. Ciphertext layout is `wrappedDEK ‖ nonce ‖ ct ‖ tag`, AES-256-GCM, **AAD = `entity_id + field_name`** so ciphertext cannot be swapped between rows or fields. Searchable S3 fields get a companion `<field>_bidx bytea` = `HMAC-SHA256(k_class, normalise(plaintext))`.

**Fail closed:** if Vault is sealed or unreachable, S2/S3 operations return 503. There is no plaintext fallback, ever.

### Audit entry

```
audit.entry(id bigserial, occurred_at, actor_id, actor_role, action, entity, entity_id,
            before_hash, after_hash, purpose, prev_entry_hash, entry_hash)
entry_hash = SHA256(prev_entry_hash ‖ canonical_json(entry_without_hash))
```

Append-only: the `audit` role holds INSERT and SELECT, never UPDATE or DELETE. Daily job anchors the chain head to a separate volume.

Every service emits `audit.*` for: writes to employee/time/pay/config data, **all S3 reads**, authz denials, logins, exports and downloads, consent changes, and key operations.

### Error envelope

```json
{ "code": "ONB-001", "message_i18n_key": "onboarding.error.invalid_national_id", "details": [] }
```

Prefixes: `ONB` `SCH` `TSH` `ATT` `LVE` `CLM` `PAY` `CFG` `AUZ` `CRY` `AUD` `I18` `DOC`.
Reserved across all services: `CRY-503` crypto unavailable — write refused (fail closed) · `AUZ-403` permission denied · `AUZ-409` segregation-of-duties violation.

### Database conventions

- UUIDv7 primary keys · `created_at` / `updated_at timestamptz` · hard delete per the PDPA schedule, `deleted_at` only where retention requires it.
- Every schema has `outbox(id, topic, payload, created_at, published_at)` and `processed_events(event_id PK, processed_at)`.
- `employee_id` is replicated into per-schema `*_employee_ref` read models via `employee.*` events. **No foreign keys across schemas. No cross-schema queries.** Each service's DB role is granted only its own schema.
- Migrations run per service with `node-pg-migrate` on startup.

### Internationalisation

- All user-visible strings via i18n keys namespaced per module (`leave.request.submit`). Missing key → English fallback + logged warning. Zero missing keys is a release gate.
- Dates stored ISO-8601 Gregorian UTC, always. Thai locale renders Buddhist Era (พ.ศ. = C.E. + 543); Thai date inputs accept both (year > 2400 ⇒ B.E.). **Never store B.E.**
- Money: THB, satang precision in engines, rounding only at render.
- PDFs embed Sarabun (Thai), Noto Sans SC (Simplified Chinese), Noto Sans (Latin).

### Statutory values are data, never code

Every Thai statutory figure resolves through `svc-config` by rule key and date. No module may hard-code a rate, threshold, multiplier or bracket. The acceptance test is PRD M7-2's: a September 2026 payroll run applies no EWF and an October 2026 run applies 0.25%, with no code change.

---

## Standing constraints

- **Build only in CI**, pull from `ghcr.io/mavrone81/gadonghr-<service>`. Never `docker compose build` on the server.
- SHA-tagged images need the scoped keep-4 prune cron — plain `docker system prune` cannot see tagged images.
- Never `docker compose down -v`. Losing `vault_data` is permanent loss of every encrypted field.
- Node 22 · TypeScript strict · pnpm workspaces · Jest · conventional commits.
- Coverage gates: ≥85% lines on engine packages; **100% branch on `GrossToNetEngine` and `OtClassifier`**.
- Secrets never committed; `.env` is server-side only, chmod 600.

## Open items that block later phases

| Item | Blocks | Owner |
|---|---|---|
| PRD Q2 — CompreFace FAR/FRR benchmark on Thai/Chinese faces, CPU latency < 2 s | Phase 3 exit | Engineering |
| Statutory §12 V2 — exact gazetted 2026 SSO ceiling (17,500 assumed) | Phase 5 config freeze | Legal |
| Statutory §12 V1 — LPA No. 9 maternity pay split (employer vs SSO days) | Phase 4 | Legal |
| Statutory §12 V4 — 2026 provincial minimum-wage table | Phase 5 | Legal |
| UI direction selection | Phase 2 web shell | Product |
| **4 GB RAM ceiling** — Phase 1 fits; Phase 3 adds CompreFace (2–3 GB) | Phase 3 | Product |
