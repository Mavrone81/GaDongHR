# GaDongHR — Seed / Master Data Specification

| Field | Value |
|---|---|
| Version | 0.1 (Draft) · Date 2026-08-02 · Stage 5 |
| Loader | `scripts/seed.sh` → `svc-config` seeder (idempotent, versioned packs, signed) |

## 1. Pack Inventory

| Pack id | Contents | Source of truth | Update cadence |
|---|---|---|---|
| `TH-STATUTORY-<ver>` | Every rule in Statutory Spec §3–§9 with floors, citations, effective dates (incl. superseded pre-Dec-2025 leave rules and future-dated EWF rows) | Royal Gazette / SSO / RD (Verification Log §12) | On law change (signed pack) |
| `TH-MINWAGE-<ver>` | 77 provinces × daily minimum wage, effective-dated | Wage Committee notification | Per notification |
| `TH-HOLIDAYS-<year>` | Annual public holiday list (see §2) | Cabinet/BoT announcements | Yearly, ~Q4 prior year |
| `TH-PROVINCES` | 77 provinces + districts + sub-districts + postcodes (address picker) | DOPA reference data | Rare |
| `TH-BANKS` | Bank codes/names for payroll files (KBank 004, BBL 002, SCB 014, Krungsri 025, KTB 006, TTB 011, GSB 030, UOB 024, CIMB 022 …) | BOT bank codes | Rare |
| `SSO-HOSPITALS` (P1) | SSO hospital list for employee selection | SSO | Yearly |
| `RBAC-TEMPLATES` | Role templates + permission catalog (Security doc §4.2) | Product | Per release |
| `I18N-<ver>` | th/en/zh bundles + glossary | Product (native-reviewed) | Per release |
| `CLAIM-DEFAULTS` | Starter claim types (travel/meal/medical/per-diem/mileage @ configurable rate) | Product | Per release |
| `SHIFT-DEFAULTS` | Office 9–18, factory 3-shift pattern examples | Product | Per release |
| `CONSENT-FORMS-<ver>` | Privacy notice + biometric consent templates th/en/zh (PDPA doc §9) | Product + counsel | On counsel review |
| `FIXTURE-SIAMTEST` (test profile only) | Siam Test Co. tenant (Test Strategy §3) | Product | Per release |

Pack format on the wire (`POST /packs/import`): signed JSON `{pack_id, version, signature, records[]}`. The committed source files under `services/svc-config/seed/*.json` carry NO `signature` field — only `{pack_id, version, records[]}` — because a signature baked in at authoring time verifies only under the one `CONFIG_PACK_SIGNING_KEY` that produced it, and every deployment generates its own. `deploy/scripts/seed.sh` signs each pack for the target environment's own key, via `services/svc-config/src/scripts/sign-pack.ts`, immediately before import — never at authoring/commit time. Import runs through the same governance approval as manual rule edits; seeder is idempotent by `(pack_id, version)`.

## 2. `TH-HOLIDAYS-2026` (private-sector default set — company confirms in wizard; lunar-calendar dates depend on annual announcements → marked VERIFY)

| Date 2026 | Holiday |
|---|---|
| Jan 1 (Thu) | New Year's Day |
| Mar 3 (Tue) VERIFY | Makha Bucha Day |
| Apr 6 (Mon) | Chakri Memorial Day |
| Apr 13–15 (Mon–Wed) | Songkran Festival |
| May 1 (Fri) | National Labour Day (mandatory — LPA s.29) |
| May 4 (Mon) | Coronation Day |
| Jun 1 (Mon) VERIFY | Visakha Bucha Day |
| Jul 29 (Wed) VERIFY | Asarnha Bucha Day |
| Jul 28 (Tue) | H.M. King's Birthday |
| Aug 12 (Wed) | H.M. Queen Mother's Birthday / Mother's Day |
| Oct 13 (Tue) | King Bhumibol Memorial Day |
| Oct 23 (Fri) | Chulalongkorn Day |
| Dec 5 (Sat) | King Bhumibol's Birthday / Father's Day (substitute Mon Dec 7) |
| Dec 10 (Thu) | Constitution Day |
| Dec 31 (Thu) | New Year's Eve |

≥13 must remain selected (floor); substitute-day auto-generation per Scheduler M2-3. Buddhist lunar dates and any special cabinet holidays must be reconciled with the official 2026 announcement before seeding production.

## 3. Role Template Seed (extract — full catalog generated from `authz` permission list)
employee-ess, line-manager, hr-officer, payroll-officer, payroll-approver, hr-system-admin, compliance-approver, dpo, auditor-readonly, kiosk-device — exactly per Security doc §4.2 including the global absence of `biometric.template.read` from every human role.

## 4. Acceptance for Seed Packs
Seeder run twice ⇒ identical state (idempotency test); statutory pack loads produce zero floor violations; holiday pack < 13 rejected; every i18n key referenced in code exists in all three bundles (CI check); signature verification failure blocks import.
