# GaDongHR — Database Design (ERD & Data Flows)

| Field | Value |
|---|---|
| Version | 0.1 (Draft) |
| Date | 2026-08-02 |
| Status | Stage 2 deliverable |
| DBMS | PostgreSQL 16 — one instance, schema-per-service (ADR-003) |

## 1. Conventions

- Schemas: `onboarding`, `scheduler`, `timesheet`, `attendance`, `leave`, `claims`, `payroll`, `authz`, `config`, `audit`, `notify`, `docs`. Each service's DB role can access **only its own schema** (enforced via GRANTs) — cross-service data travels by events/APIs only.
- `id` = UUIDv7 PK; `created_at/updated_at timestamptz`; soft delete only where retention requires (`deleted_at`), otherwise hard delete per PDPA schedule.
- **Encrypted columns** are marked 🔐 — stored as `bytea` ciphertext (envelope-encrypted by `svc-crypto` before INSERT/UPDATE; see Security doc §3). Searchable encrypted fields get a companion `*_bidx` (blind index, HMAC-SHA256, `bytea`) — plaintext never indexed.
- Every schema has `processed_events(event_id PK, processed_at)` for consumer idempotency and `outbox(id, topic, payload, created_at, published_at)` for transactional event publishing.
- Employee identity across services: `employee_id` (UUID) replicated via `employee.*` events into local read models (`*_employee_ref` tables) — no foreign keys across schemas.

## 2. Core ERDs (key tables per schema)

### 2.1 `onboarding` (M1 — system of record for people)

```mermaid
erDiagram
    EMPLOYEE ||--o{ EMPLOYEE_DOCUMENT : has
    EMPLOYEE ||--o{ CONSENT_RECORD : gives
    EMPLOYEE ||--o{ ONBOARDING_TASK : assigned
    EMPLOYEE ||--o| PROBATION : tracked
    EMPLOYEE }o--|| ORG_UNIT : belongs_to
    EMPLOYEE }o--|| POSITION : holds
    CONSENT_FORM ||--o{ CONSENT_RECORD : versioned_as

    EMPLOYEE {
        uuid id PK
        text emp_code UK
        bytea first_name_th "🔐"
        bytea last_name_th "🔐"
        bytea first_name_en "🔐"
        bytea last_name_en "🔐"
        bytea name_zh "🔐 nullable"
        bytea national_id "🔐"
        bytea national_id_bidx "blind index UK"
        bytea passport_no "🔐 nullable"
        bytea tax_id "🔐"
        bytea sso_number "🔐"
        bytea bank_account "🔐"
        text bank_code
        bytea dob "🔐"
        bytea address "🔐 JSON th format"
        bytea phone "🔐"
        bytea email "🔐"
        bytea email_bidx
        text employment_type "monthly|daily|hourly|contract"
        uuid org_unit_id FK
        uuid position_id FK
        text province_code "min-wage validation"
        date start_date
        date termination_date "nullable"
        text status "onboarding|active|terminated"
        text preferred_lang "th|en|zh"
    }
    CONSENT_RECORD {
        uuid id PK
        uuid employee_id FK
        uuid consent_form_id FK
        text purpose "biometric|hr_processing|..."
        text state "granted|refused|withdrawn"
        text lang_shown
        timestamptz decided_at
        bytea form_text_snapshot "🔐 as-shown"
    }
    ONBOARDING_TASK {
        uuid id PK
        uuid employee_id FK
        text task_key "e.g. sso_registration"
        date due_date "start+30 for SSO"
        text status
    }
```

`ORG_UNIT(id, parent_id, name_i18n jsonb, cost_center)` forms the tree used by RBAC data-scoping (`authz` caches it).

### 2.2 `attendance` (M4) — biometric isolation

```mermaid
erDiagram
    ENROLLMENT ||--o{ PUNCH_EVENT : produces
    DEVICE ||--o{ PUNCH_EVENT : captures
    ENROLLMENT {
        uuid id PK
        uuid employee_id UK
        text method "face|pin|qr|badge"
        text face_subject_ref "CompreFace subject id, opaque"
        text status "active|suspended|deleted"
        timestamptz enrolled_at
        timestamptz template_deleted_at "consent withdrawal / termination"
    }
    DEVICE {
        uuid id PK
        text kind "kiosk|mobile"
        text site_code
        bytea device_secret "🔐"
        text status
    }
    PUNCH_EVENT {
        uuid id PK
        text idem_key UK "device+seq"
        uuid employee_id
        uuid device_id FK
        timestamptz punched_at
        text direction "in|out"
        text method "face|pin|qr|badge|manual"
        numeric match_score "nullable"
        bool liveness_passed
        text site_code
        jsonb geo "nullable, PWA geofence P1"
    }
```

**Face templates live only inside the CompreFace container's own Postgres schema** (its embeddings), keyed by an opaque `face_subject_ref`; GaDongHR schemas never store embeddings. CompreFace's storage volume is encrypted at rest, and deletion of a subject on consent withdrawal is verified by `svc-attendance` (PDPA doc §4.4). Raw images are never persisted by `svc-attendance` (PDPA doc §5).

### 2.3 `scheduler` (M2), `timesheet` (M3)

```mermaid
erDiagram
    SHIFT ||--o{ ROSTER_ENTRY : used_in
    ROSTER_ENTRY }o--|| EMPLOYEE_REF : for
    HOLIDAY_CALENDAR ||--o{ HOLIDAY : contains
    OT_REQUEST }o--|| EMPLOYEE_REF : for

    SHIFT { uuid id PK
        jsonb name_i18n
        time start_t
        time end_t
        bool crosses_midnight
        jsonb break_rules
        int grace_min
        jsonb differential }
    ROSTER_ENTRY { uuid id PK
        uuid employee_id
        uuid shift_id FK
        date work_date
        text status "planned|published"
        text override_reason "nullable" }
    OT_REQUEST { uuid id PK
        uuid employee_id
        date ot_date
        numeric hours
        text rate_class "workday|holiday_work|holiday_ot"
        text status "pending|approved|rejected"
        uuid approved_by }
    DAY_RECORD ||--o{ TIME_EXCEPTION : raises
    DAY_RECORD }o--|| PERIOD : in
    DAY_RECORD { uuid id PK
        uuid employee_id
        date work_date
        uuid roster_entry_id "nullable"
        timestamptz actual_in
        timestamptz actual_out
        numeric worked_hours
        numeric late_min
        numeric ot_15x
        numeric ot_2x
        numeric ot_3x
        text leave_code "nullable"
        text status "ok|exception|corrected" }
    TIME_EXCEPTION { uuid id PK
        uuid day_record_id FK
        text kind "missed_punch|late|absence|unapproved_ot"
        text resolution
        uuid resolved_by
        text reason }
    PERIOD { uuid id PK
        daterange range UK
        text status "open|locked"
        int lock_version
        uuid locked_by
        timestamptz locked_at }
```

### 2.4 `leave` (M5), `claims` (M6)

```mermaid
erDiagram
    LEAVE_TYPE ||--o{ LEAVE_BALANCE : accrues
    LEAVE_TYPE ||--o{ LEAVE_REQUEST : typed
    LEAVE_REQUEST ||--o{ APPROVAL_STEP : chain
    LEAVE_TYPE { uuid id PK
        text code "annual|sick|business|maternity|paternity|infant_care|..."
        jsonb name_i18n
        text pay_mode "full|half|unpaid|per_rule"
        text accrual_mode "annual_grant|monthly|anniversary"
        text statutory_rule_key "nullable → config svc floor check" }
    LEAVE_BALANCE { uuid id PK
        uuid employee_id
        uuid leave_type_id FK
        numeric entitled
        numeric taken
        numeric carried_over
        int year }
    LEAVE_REQUEST { uuid id PK
        uuid employee_id
        uuid leave_type_id FK
        daterange dates
        numeric days "supports 0.5/hourly"
        bytea attachment_ref "🔐 medical cert pointer"
        text status }
    CLAIM ||--o{ APPROVAL_STEP2 : chain
    CLAIM ||--o{ RECEIPT : evidences
    CLAIM { uuid id PK
        uuid employee_id
        text claim_type
        numeric amount_thb
        text status "draft|pending|approved|for_payroll|paid_offcycle|rejected"
        text dup_hash "amount+date+vendor" }
    RECEIPT { uuid id PK
        uuid claim_id FK
        bytea file_ref "🔐 MinIO pointer"
        numeric vat_amount }
```

`APPROVAL_STEP(id, subject_id, level, approver_role, approver_id, decided_at, decision, comment)` is a shared pattern (per-schema copy).

### 2.5 `payroll` (M7)

```mermaid
erDiagram
    PAY_PROFILE }o--|| EMPLOYEE_REF : for
    PAYROLL_RUN ||--o{ PAYSLIP : produces
    PAYSLIP ||--o{ PAY_ITEM : itemises
    PAYROLL_RUN ||--o{ STATUTORY_EXPORT : generates
    PAY_PROFILE { uuid id PK
        uuid employee_id UK
        bytea base_pay "🔐"
        text pay_basis "monthly|daily|hourly"
        jsonb recurring_items "refs, amounts 🔐 in items table"
        bytea pf_rate "🔐 provident fund %"
        bytea tax_allowance_decl "🔐 ล.ย.01 data" }
    PAYROLL_RUN { uuid id PK
        text period "YYYY-MM"
        text run_type "regular|offcycle|adjustment|final_pay"
        int timesheet_lock_version "binds to PERIOD.lock_version"
        text status "draft|calculated|reviewed|approved|committed"
        uuid prepared_by
        uuid approved_by "must differ (SoD)"
        jsonb rulepack_versions "statutory config snapshot" }
    PAYSLIP { uuid id PK
        uuid run_id FK
        uuid employee_id
        bytea gross "🔐"
        bytea sso_emp "🔐"
        bytea ewf_emp "🔐"
        bytea pf_emp "🔐"
        bytea tax_wht "🔐"
        bytea net "🔐"
        bytea ytd "🔐 json"
        bytea pdf_ref "🔐 MinIO pointer" }
    STATUTORY_EXPORT { uuid id PK
        uuid run_id FK
        text kind "sso_1_10|pnd1|bank_csv|pnd1kor|50bis|kor_ror_11"
        bytea file_ref "🔐"
        text status "generated|downloaded" }
```

Committed runs are immutable (DB trigger blocks UPDATE/DELETE on `status='committed'`; corrections are new `adjustment` runs).

### 2.6 `config` (statutory rules), `authz`, `audit`

- `config.statutory_rule(id, rule_key, value jsonb, unit, statutory_floor jsonb, ceiling jsonb, citation, effective_from, effective_to, governance_class, status, proposed_by, approved_by, reason)` — exactly the Statutory Spec §1 model; unique on `(rule_key, effective_from)`.
- `authz.role(id, code, name_i18n)`, `authz.permission(code)`, `authz.role_permission`, `authz.user_role(user_id, role_id, org_scope_unit_id)` — org-scoped role grants (Security doc §4).
- `audit.entry(id bigserial, occurred_at, actor_id, actor_role, action, entity, entity_id, before_hash, after_hash, purpose, prev_entry_hash, entry_hash)` — hash-chained, append-only (INSERT-only role; no UPDATE/DELETE grants).

## 3. Data Flow Diagrams

### 3.1 Punch → Timesheet → Payroll (with encryption boundaries)

```mermaid
flowchart LR
    subgraph capture [Capture]
      CAM[Camera frame<br/>memory only] --> MATCH[CompreFace match]
    end
    MATCH -->|subject_ref| ATT[svc-attendance]
    ATT -->|outbox| E1{{attendance.punch}}
    E1 --> TSH[svc-timesheet<br/>merge roster+leave]
    TSH -->|lock| E2{{timesheet.locked}}
    E2 --> PAY[svc-payroll]
    CFG[svc-config<br/>statutory rules] --> TSH
    CFG --> PAY
    PAY -->|encrypt via svc-crypto| DB[(payroll schema<br/>ciphertext)]
    PAY --> XPT[SSO / PND1 / bank files<br/>encrypted in MinIO]
```

### 3.2 Onboarding write path (encrypt-before-write)

```mermaid
sequenceDiagram
    participant UI as web (HR)
    participant ONB as svc-onboarding
    participant CR as svc-crypto
    participant V as vault transit
    participant PG as postgres
    UI->>ONB: POST /employees {plain fields, TLS}
    ONB->>CR: encryptBatch(fields, class=SENSITIVE, aad=employee_id)
    CR->>V: generate data key (wrapped)
    CR-->>ONB: ciphertexts + blind indexes
    ONB->>PG: INSERT (bytea ciphertext only)
    ONB->>PG: INSERT outbox employee.created (non-sensitive payload)
```

Events **never carry sensitive plaintext** — consumers needing a sensitive field fetch it by ID through the owning service's API (authorised + audited).

## 4. Retention Enforcement

Nightly `retention-job` (container) queries each schema's retention view (driven by PDPA doc §7 schedule in `config`), moves candidates to a DPO review queue, then performs **crypto-erasure** (destroy per-record data key via `svc-crypto`) followed by physical DELETE. Legal-hold flags on employee/payroll rows block deletion and surface the blocking statute + date.

## 5. Migration & Versioning

- Per-service migrations (`node-pg-migrate`), run by an init container per service on startup; schema version table per schema.
- Seed packs: statutory rules (Statutory Spec), Thai holidays, provinces + minimum wage, banks, role templates, i18n bundles — loaded by `svc-config` seeder, idempotent.
