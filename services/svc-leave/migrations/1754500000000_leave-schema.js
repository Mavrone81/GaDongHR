'use strict'

/**
 * `leave` schema — Task 14 brief, DATABASE-DESIGN.md §2.4, exactly:
 *
 *   leave.leave_type(id uuid pk, code text unique, name_i18n jsonb,
 *     pay_mode text, accrual_mode text, statutory_rule_key text null)
 *   leave.leave_balance(id uuid pk, employee_id uuid, leave_type_id uuid fk,
 *     entitled numeric, taken numeric, carried_over numeric, year int)
 *   leave.leave_request(id uuid pk, employee_id uuid, leave_type_id uuid fk,
 *     dates daterange, days numeric, attachment_ref bytea, status text)
 *   leave.approval_step(id uuid pk, subject_id uuid, level int,
 *     approver_role text, approver_id uuid, decided_at timestamptz,
 *     decision text, comment text) — the shared per-schema APPROVAL_STEP
 *     pattern (DATABASE-DESIGN.md §2.4 closing note); `subject_id` carries
 *     no FK here, matching the brief's shape exactly (unlike
 *     `leave_balance.leave_type_id`/`leave_request.leave_type_id`, which
 *     the brief explicitly marks `fk`) — it is a generic "what this step is
 *     deciding on" reference, not narrowed to `leave_request.id` at the DB
 *     level.
 *   leave.leave_employee_ref(employee_id uuid pk, status text,
 *     updated_at timestamptz) — a read model fed by `employee.*` events
 *     (DATABASE-DESIGN.md §1: "Employee identity across services ... no
 *     foreign keys across schemas"; roadmap event catalog:
 *     `employee.created`/`employee.updated`/`employee.terminated`).
 *     Deliberately carries no `references` to `onboarding.employee` — that
 *     table lives in a schema this service's DB role cannot even see.
 *
 * Plus the two tables every schema carries: `outbox` and
 * `processed_events(event_id PK)` (roadmap "Database conventions").
 *
 * ---------------------------------------------------------------------
 * WHY THIS FILE IS THE SAFETY BOUNDARY FOR M5 (Task 14 brief, "why this
 * service matters"):
 *
 * `leave_request.attachment_ref` points at a medical certificate — health
 * data under PDPA s.26, the same sensitivity class as the biometric
 * template boundary `svc-attendance` draws around `face_subject_ref`. It
 * is declared `bytea`, not `text`: the pointer is envelope-encrypted by
 * `svc-crypto` before every INSERT/UPDATE (kernel `CryptoClient`, matching
 * `attendance.device.device_secret`'s pattern), never written in the
 * clear. `leave-schema.test.ts` enumerates every `bytea` column in this
 * schema explicitly, so a future migration that adds a second one (or
 * quietly widens this one to `text`) fails the build rather than merely
 * being missed in review.
 *
 * `leave_balance.entitled/taken/carried_over` and `leave_request.days` are
 * all `numeric`, never `real`/`double precision`. `days` supports 0.5 for
 * half-days and finer for hourly leave; unused annual leave converts to a
 * cash payout on termination (Statutory Spec — LPA), so a float rounding
 * error in any of these four columns is a payroll error, not a display
 * glitch. `leave-schema.test.ts` asserts each column's type by name and
 * demonstrates the assertion failing when one is changed to
 * `double precision`.
 *
 * `leave_type.statutory_rule_key` is how a leave type binds to its floor
 * in `svc-config` (`config.statutory_rule.rule_key` — DATABASE-DESIGN.md
 * §2.6). It is NULLABLE ON PURPOSE: company-defined leave types (e.g. a
 * bespoke "study_leave") have no statutory floor to bind to. Do not
 * "fix" this to NOT NULL — that would make it impossible to create a
 * company-only leave type. See the `COMMENT ON COLUMN` below, written so a
 * future reader hits the rationale in `\d+ leave.leave_type` output
 * itself, not only in this migration's source.
 *
 * Business logic — accrual, balance calculation, approval chains,
 * carry-over — is explicitly out of scope for this task (Task 14 brief:
 * "Phase 4 owns those"). This migration exists so the shape is right
 * before any of that code is written, not to implement it.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 14 brief CONSTRAINTS, matching Tasks 7/8/9/13's precedent);
 * a later integration task re-proves this against real Postgres.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('leave', { ifNotExists: true })

  pgm.createTable(
    { schema: 'leave', name: 'leave_type' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      code: { type: 'text', notNull: true },
      name_i18n: { type: 'jsonb', notNull: true },
      pay_mode: { type: 'text', notNull: true },
      accrual_mode: { type: 'text', notNull: true },
      // Nullable ON PURPOSE — see file-level comment and the COMMENT ON
      // COLUMN below. NOT an oversight: company-defined leave types have
      // no statutory floor in `config.statutory_rule` to bind to.
      statutory_rule_key: { type: 'text' },
    },
    {
      constraints: {
        leave_type_code_key: { unique: ['code'] },
        leave_type_pay_mode_check: { check: "pay_mode IN ('full', 'half', 'unpaid', 'per_rule')" },
        leave_type_accrual_mode_check: {
          check: "accrual_mode IN ('annual_grant', 'monthly', 'anniversary')",
        },
      },
    },
  )

  pgm.sql(`COMMENT ON COLUMN leave.leave_type.statutory_rule_key IS
    'Binds this leave type to its floor in config.statutory_rule(rule_key). NULLABLE ON PURPOSE, not an oversight: company-defined leave types (e.g. a bespoke study_leave) have no statutory floor to bind to and must be creatable with this column left null.'`)

  pgm.createTable(
    { schema: 'leave', name: 'leave_balance' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: { type: 'uuid', notNull: true },
      leave_type_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'leave', name: 'leave_type' },
        referencesConstraintName: 'leave_balance_leave_type_id_fkey',
      },
      // numeric, never real/double precision — see file-level comment: an
      // unused annual-leave balance becomes a cash payout on termination,
      // so a float rounding error here is a payroll error.
      entitled: { type: 'numeric', notNull: true },
      taken: { type: 'numeric', notNull: true, default: 0 },
      carried_over: { type: 'numeric', notNull: true, default: 0 },
      year: { type: 'integer', notNull: true },
    },
    {
      constraints: {
        // One balance row per employee/type/year — the natural key this
        // table models (DATABASE-DESIGN.md §2.4's `LEAVE_TYPE ||--o{
        // LEAVE_BALANCE : accrues`, one balance per accrual period).
        leave_balance_employee_type_year_key: { unique: ['employee_id', 'leave_type_id', 'year'] },
      },
    },
  )
  pgm.createIndex({ schema: 'leave', name: 'leave_balance' }, ['employee_id', 'year'])

  pgm.createTable(
    { schema: 'leave', name: 'leave_request' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: { type: 'uuid', notNull: true },
      leave_type_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'leave', name: 'leave_type' },
        referencesConstraintName: 'leave_request_leave_type_id_fkey',
      },
      dates: { type: 'daterange', notNull: true },
      // numeric, never real/double precision — supports 0.5 for half-days
      // and finer for hourly leave (see file-level comment).
      days: { type: 'numeric', notNull: true },
      // The one legitimate bytea column in this schema — see the
      // file-level comment and `leave-schema.test.ts`'s explicit
      // enumeration test. Points at a medical certificate (health data,
      // PDPA s.26); the pointer itself is envelope-encrypted by
      // `svc-crypto` before every INSERT/UPDATE, never written in the
      // clear. Nullable: only a sick-leave request with a certificate
      // populates it — most requests never do.
      attachment_ref: { type: 'bytea' },
      status: { type: 'text', notNull: true, default: 'pending' },
    },
    {
      constraints: {
        leave_request_status_check: {
          check: "status IN ('pending', 'approved', 'rejected', 'cancelled')",
        },
      },
    },
  )
  pgm.createIndex({ schema: 'leave', name: 'leave_request' }, ['employee_id'])
  pgm.createIndex({ schema: 'leave', name: 'leave_request' }, ['leave_type_id'])

  pgm.sql(`COMMENT ON COLUMN leave.leave_request.attachment_ref IS
    'Pointer to a medical certificate -- health data under PDPA s.26. Always envelope-encrypted by svc-crypto before INSERT/UPDATE -- never written in the clear (Security doc section 3). Must remain bytea; never text.'`)

  // Shared per-schema APPROVAL_STEP pattern (DATABASE-DESIGN.md §2.4
  // closing note). `subject_id` carries no FK — see file-level comment for
  // why that matches the brief's shape exactly.
  pgm.createTable(
    { schema: 'leave', name: 'approval_step' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      subject_id: { type: 'uuid', notNull: true },
      level: { type: 'integer', notNull: true },
      approver_role: { type: 'text', notNull: true },
      approver_id: { type: 'uuid' },
      decided_at: { type: 'timestamptz' },
      decision: { type: 'text' },
      comment: { type: 'text' },
    },
    {
      constraints: {
        approval_step_decision_check: {
          check: "decision IS NULL OR decision IN ('approved', 'rejected')",
        },
      },
    },
  )
  pgm.createIndex({ schema: 'leave', name: 'approval_step' }, ['subject_id', 'level'])

  // Read model fed by `employee.*` events (DATABASE-DESIGN.md §1) — no
  // `references` to `onboarding.employee`: cross-schema foreign keys are
  // disallowed by convention (each service's DB role can see only its own
  // schema; a cross-schema FK would not even be enforceable by every
  // role). Populated by a future `idempotent()`-driven consumer, not by
  // this migration.
  pgm.createTable(
    { schema: 'leave', name: 'leave_employee_ref' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      status: { type: 'text', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )

  pgm.createTable(
    { schema: 'leave', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'leave', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (roadmap "Database conventions").
  pgm.createTable(
    { schema: 'leave', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  pgm.dropSchema('leave', { cascade: true, ifExists: true })
}
