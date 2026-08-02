'use strict'

/**
 * `onboarding` schema — Task 14 brief, DATABASE-DESIGN.md §2.1's ERD
 * reproduced faithfully: EMPLOYEE, EMPLOYEE_DOCUMENT, CONSENT_RECORD,
 * CONSENT_FORM, ONBOARDING_TASK, PROBATION, ORG_UNIT, POSITION. This is
 * M1 — the system of record for people: every Thai employee's national
 * ID, bank account, address, and PDPA consent records live here.
 *
 * **Every column marked 🔐 in the ERD is `bytea`, never `text`** — that is
 * the whole point of this migration. `svc-crypto` (Task 6) envelope-
 * encrypts each one before this service ever issues an INSERT/UPDATE
 * (kernel `CryptoClient.encryptBatch`, wired in Phase 2 — this task only
 * shapes the column so ciphertext is the only thing that can ever be
 * written into it; a `text` column would silently accept plaintext).
 * Searchable 🔐 fields get a companion `<field>_bidx bytea` blind index
 * (HMAC-SHA256, kernel `CryptoClient.blindIndex`) — `national_id_bidx` is
 * `UNIQUE`, which is the actual mechanism behind M1-1's acceptance
 * criterion "a duplicate national ID is blocked" (ONB-002); `email_bidx`
 * is indexed but not unique (an employee's declared email is not
 * guaranteed globally unique the way a national ID is).
 *
 * `EMPLOYEE_DOCUMENT`, `CONSENT_FORM`, `POSITION` have no column list in
 * the ERD's mermaid block — only relationship edges — so their shape here
 * is inferred from `docs/05-modules/M1-ONBOARDING.md` (self-service
 * upload flow §1.1, class diagram §2, API manual §3.1) and from the
 * established sibling-schema convention for storage pointers: every other
 * schema's file/blob pointer column (`docs.document.file_ref`,
 * `claims.RECEIPT.file_ref`, `payroll.PAYSLIP.pdf_ref` — DATABASE-DESIGN
 * §2.4/§2.5, and `services/svc-docs`'s actual `file_ref bytea` column) is
 * `bytea`, so `employee_document.file_ref` follows that same treatment
 * here even though the ERD box for EMPLOYEE_DOCUMENT itself is empty.
 * `ORG_UNIT`'s shape is given directly in DATABASE-DESIGN §2.1's prose
 * below the diagram: `ORG_UNIT(id, parent_id, name_i18n jsonb,
 * cost_center)` — this is the SOURCE tree (`svc-authz`'s Task 8
 * `authz.org_unit` is a read-model CACHE of it, per that same sentence:
 * "forms the tree used by RBAC data-scoping (authz caches it)").
 *
 * Plus the two tables every schema carries: `outbox` and
 * `processed_events(event_id PK)` (roadmap "Database conventions").
 * `gen_random_uuid()` is built into Postgres core since 13 — no
 * `pgcrypto` extension needed on Postgres 16. The roadmap's "UUIDv7
 * primary keys" convention is aspirational for a future Postgres (native
 * `uuidv7()` ships in PG 18, not 16 — DATABASE-DESIGN.md §"DBMS" pins PG
 * 16 for this program); every existing migration in this repo
 * (svc-config, svc-authz, svc-docs, svc-notify) already resolves that gap
 * the same way, with `gen_random_uuid()` (UUIDv4) as the PK default — this
 * migration follows that same established precedent rather than inventing
 * a one-off v7 shim.
 *
 * No GRANT/REVOKE role restrictions here (unlike `audit`, which is
 * deliberately append-only) — `onboarding`'s own DB role gets the normal
 * full CRUD grant that every non-audit schema gets via the shared role
 * bootstrap (`deploy/postgres/init`, outside this service's directory),
 * matching `svc-config`/`svc-docs`/`svc-authz`'s migrations, none of which
 * carry their own GRANT statements either.
 *
 * Business logic — the actual encrypt-before-write path, consent
 * workflow, probation decisioning, checklist escalation, and outbox event
 * publication — is explicitly Phase 2 (Task 14 brief: "makes the service
 * exist, deploy, and have a correct database shape"). This migration only
 * shapes the tables that logic will write into.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 14 brief CONSTRAINTS); a later integration task runs this
 * for real, the same deferred verification every prior schema migration
 * in this repo documents (svc-config, svc-audit, svc-authz, svc-docs).
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('onboarding', { ifNotExists: true })

  // --- ORG_UNIT — created first: EMPLOYEE and POSITION both FK into it ---
  pgm.createTable(
    { schema: 'onboarding', name: 'org_unit' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      parent_id: {
        type: 'uuid',
        references: { schema: 'onboarding', name: 'org_unit' },
        referencesConstraintName: 'org_unit_parent_id_fkey',
      },
      name_i18n: { type: 'jsonb', notNull: true },
      cost_center: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.createIndex({ schema: 'onboarding', name: 'org_unit' }, ['parent_id'])

  // --- POSITION — created before EMPLOYEE: EMPLOYEE FKs into it ---
  pgm.createTable(
    { schema: 'onboarding', name: 'position' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      code: { type: 'text', notNull: true },
      title_i18n: { type: 'jsonb', notNull: true },
      org_unit_id: {
        type: 'uuid',
        references: { schema: 'onboarding', name: 'org_unit' },
        referencesConstraintName: 'position_org_unit_id_fkey',
      },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { constraints: { position_code_key: { unique: ['code'] } } },
  )
  pgm.createIndex({ schema: 'onboarding', name: 'position' }, ['org_unit_id'])

  // --- EMPLOYEE — DATABASE-DESIGN §2.1, every 🔐 column is bytea ---
  pgm.createTable(
    { schema: 'onboarding', name: 'employee' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      emp_code: { type: 'text', notNull: true },

      // 🔐 name fields — S2 (roadmap "Data classification": names/contacts/DOB/address are S2).
      first_name_th: { type: 'bytea', notNull: true },
      last_name_th: { type: 'bytea', notNull: true },
      first_name_en: { type: 'bytea', notNull: true },
      last_name_en: { type: 'bytea', notNull: true },
      name_zh: { type: 'bytea' }, // 🔐 nullable — not every employee has a Chinese name on file

      // 🔐 S3 identity fields — the actual PDPA-critical columns this task exists for.
      national_id: { type: 'bytea', notNull: true },
      national_id_bidx: { type: 'bytea', notNull: true }, // blind index — UNIQUE below is ONB-002's mechanism
      passport_no: { type: 'bytea' }, // 🔐 nullable — Thai nationals may have none on file
      tax_id: { type: 'bytea', notNull: true },
      sso_number: { type: 'bytea', notNull: true },
      bank_account: { type: 'bytea', notNull: true },
      bank_code: { type: 'text', notNull: true }, // not 🔐 in the ERD — a bank's routing code, not identifying on its own
      dob: { type: 'bytea', notNull: true },
      address: { type: 'bytea', notNull: true }, // 🔐 JSON th format, ciphertext of the serialised JSON
      phone: { type: 'bytea', notNull: true },
      email: { type: 'bytea', notNull: true },
      email_bidx: { type: 'bytea', notNull: true }, // blind index — indexed, not unique (see file header)

      employment_type: { type: 'text', notNull: true },
      org_unit_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'onboarding', name: 'org_unit' },
        referencesConstraintName: 'employee_org_unit_id_fkey',
      },
      position_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'onboarding', name: 'position' },
        referencesConstraintName: 'employee_position_id_fkey',
      },
      province_code: { type: 'text', notNull: true }, // min-wage validation (Phase 2)
      start_date: { type: 'date', notNull: true },
      termination_date: { type: 'date' },
      status: { type: 'text', notNull: true, default: 'draft' },
      preferred_lang: { type: 'text', notNull: true },

      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        employee_emp_code_key: { unique: ['emp_code'] },
        // The actual M1-1 acceptance criterion ("a duplicate national ID is
        // blocked") lives here, not in application code — a second INSERT
        // whose bidx collides with an existing row's is rejected by
        // Postgres itself, even if `EmployeeService` (Phase 2) had a bug.
        employee_national_id_bidx_key: { unique: ['national_id_bidx'] },
        employee_employment_type_check: {
          check: "employment_type IN ('monthly', 'daily', 'hourly', 'contract')",
        },
        // Full lifecycle vocabulary per M1-ONBOARDING.md §1.2's state
        // diagram (draft → onboarding → active → terminated, plus the
        // onboarding → cancelled no-show/withdrawn branch) — a superset of
        // the ERD box's abbreviated "onboarding|active|terminated" comment,
        // needed because `draft` is the diagram's own documented start
        // state and `cancelled` is a real terminal state Phase 2 must be
        // able to write.
        employee_status_check: {
          check: "status IN ('draft', 'onboarding', 'active', 'cancelled', 'terminated')",
        },
        employee_preferred_lang_check: {
          check: "preferred_lang IN ('th', 'en', 'zh')",
        },
      },
    },
  )
  pgm.createIndex({ schema: 'onboarding', name: 'employee' }, ['org_unit_id'])
  pgm.createIndex({ schema: 'onboarding', name: 'employee' }, ['position_id'])
  pgm.createIndex({ schema: 'onboarding', name: 'employee' }, ['status'])
  pgm.createIndex({ schema: 'onboarding', name: 'employee' }, ['email_bidx'])

  // --- EMPLOYEE_DOCUMENT — no column list in the ERD box (relationship
  // edge only); shape inferred from M1-ONBOARDING.md §1.1's self-service
  // upload flow ("ID card, house reg, bank book, certificates" + HR
  // verify/reject) and the sibling-schema file-pointer convention (see
  // file header). `file_ref` is 🔐 by that same convention, not by an
  // explicit ERD annotation — a MinIO pointer to a scanned Thai national
  // ID card is exactly the kind of value that must never be plaintext.
  pgm.createTable(
    { schema: 'onboarding', name: 'employee_document' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'onboarding', name: 'employee' },
        referencesConstraintName: 'employee_document_employee_id_fkey',
        onDelete: 'CASCADE',
      },
      doc_type: { type: 'text', notNull: true },
      file_ref: { type: 'bytea', notNull: true }, // 🔐 MinIO pointer — see file header
      status: { type: 'text', notNull: true, default: 'pending' },
      uploaded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      verified_by: { type: 'uuid' },
      verified_at: { type: 'timestamptz' },
    },
    {
      constraints: {
        employee_document_status_check: {
          check: "status IN ('pending', 'verified', 'rejected')",
        },
      },
    },
  )
  pgm.createIndex({ schema: 'onboarding', name: 'employee_document' }, ['employee_id'])

  // --- CONSENT_FORM — versioned template text; no column list in the ERD
  // box either (relationship edge only: "CONSENT_FORM ||--o{ CONSENT_RECORD
  // : versioned_as"). Deliberately NOT 🔐: this is the boilerplate notice
  // text as published (M1-ONBOARDING.md §1.1's "PDPA consents in ESS"), not
  // any individual's personal data — `CONSENT_RECORD.form_text_snapshot` is
  // the 🔐 per-decision copy of what was actually shown to one employee.
  pgm.createTable(
    { schema: 'onboarding', name: 'consent_form' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      purpose: { type: 'text', notNull: true },
      lang: { type: 'text', notNull: true },
      version: { type: 'integer', notNull: true },
      body_text: { type: 'text', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        consent_form_purpose_lang_version_key: { unique: ['purpose', 'lang', 'version'] },
        consent_form_lang_check: { check: "lang IN ('th', 'en', 'zh')" },
      },
    },
  )

  // --- CONSENT_RECORD — DATABASE-DESIGN §2.1, verbatim ---
  pgm.createTable(
    { schema: 'onboarding', name: 'consent_record' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'onboarding', name: 'employee' },
        referencesConstraintName: 'consent_record_employee_id_fkey',
        onDelete: 'CASCADE',
      },
      consent_form_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'onboarding', name: 'consent_form' },
        referencesConstraintName: 'consent_record_consent_form_id_fkey',
      },
      purpose: { type: 'text', notNull: true }, // "biometric|hr_processing|..." — open vocabulary per ERD's own "..."
      state: { type: 'text', notNull: true },
      lang_shown: { type: 'text', notNull: true },
      decided_at: { type: 'timestamptz', notNull: true },
      form_text_snapshot: { type: 'bytea', notNull: true }, // 🔐 as-shown
    },
    {
      constraints: {
        consent_record_state_check: {
          check: "state IN ('granted', 'refused', 'withdrawn')",
        },
      },
    },
  )
  pgm.createIndex({ schema: 'onboarding', name: 'consent_record' }, ['employee_id'])
  pgm.createIndex({ schema: 'onboarding', name: 'consent_record' }, ['employee_id', 'purpose'])

  // --- ONBOARDING_TASK — DATABASE-DESIGN §2.1, verbatim ---
  pgm.createTable(
    { schema: 'onboarding', name: 'onboarding_task' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'onboarding', name: 'employee' },
        referencesConstraintName: 'onboarding_task_employee_id_fkey',
        onDelete: 'CASCADE',
      },
      task_key: { type: 'text', notNull: true }, // e.g. sso_registration
      due_date: { type: 'date', notNull: true }, // start+30 for SSO
      status: { type: 'text', notNull: true, default: 'pending' },
    },
  )
  pgm.createIndex({ schema: 'onboarding', name: 'onboarding_task' }, ['employee_id', 'status'])
  pgm.createIndex({ schema: 'onboarding', name: 'onboarding_task' }, ['due_date'])

  // --- PROBATION — no column list in the ERD box (relationship edge
  // only: "EMPLOYEE ||--o| PROBATION : tracked", a 0..1 relationship, so
  // `employee_id` is UNIQUE below). Shape inferred from
  // M1-ONBOARDING.md §1.3's probation-decision flowchart (confirm / extend
  // / terminate) and §2's class diagram (`Probation { endDate, outcome,
  // extend(newDate) }`).
  pgm.createTable(
    { schema: 'onboarding', name: 'probation' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'onboarding', name: 'employee' },
        referencesConstraintName: 'probation_employee_id_fkey',
        onDelete: 'CASCADE',
      },
      end_date: { type: 'date', notNull: true },
      outcome: { type: 'text' }, // nullable until decided
      decided_at: { type: 'timestamptz' },
      extended_to: { type: 'date' }, // set only when outcome = 'extend'
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        probation_employee_id_key: { unique: ['employee_id'] },
        probation_outcome_check: {
          check: "outcome IS NULL OR outcome IN ('confirm', 'extend', 'terminate')",
        },
      },
    },
  )

  // --- every schema carries these two (roadmap "Database conventions") ---
  pgm.createTable(
    { schema: 'onboarding', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'onboarding', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (Task 14
  // brief, matching every other schema's `processed_events` table).
  pgm.createTable(
    { schema: 'onboarding', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  pgm.dropSchema('onboarding', { cascade: true, ifExists: true })
}
