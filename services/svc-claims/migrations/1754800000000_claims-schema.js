'use strict'

/**
 * `claims` schema — Task 14 brief, DATABASE-DESIGN.md §2.4, exactly:
 *
 *   claims.claim(id uuid pk, employee_id uuid, claim_type text,
 *     amount_thb numeric, status text, dup_hash text)
 *   claims.receipt(id uuid pk, claim_id uuid fk, file_ref bytea,
 *     vat_amount numeric)
 *   claims.approval_step2(id uuid pk, subject_id uuid, level int,
 *     approver_role text, approver_id uuid, decided_at timestamptz,
 *     decision text, comment text) — the shared per-schema APPROVAL_STEP
 *     pattern (DATABASE-DESIGN.md §2.4 closing note), named `_2` here only
 *     because the ERD mermaid needs a distinct node id from `leave`'s copy
 *     (`APPROVAL_STEP`); the shape and semantics are identical.
 *     `subject_id` carries no FK, matching `leave.approval_step`'s
 *     precedent exactly — it is a generic "what this step is deciding on"
 *     reference, not narrowed to `claim.id` at the DB level.
 *   claims.claims_employee_ref(employee_id uuid pk, status text,
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
 * WHY THIS FILE IS THE SAFETY BOUNDARY FOR M6 (Task 14 brief, "why this
 * service matters"):
 *
 * `receipt.file_ref` points at a MinIO object — a photo or PDF an
 * employee uploaded of a travel/meal/medical/per-diem/mileage receipt. It
 * is declared `bytea`, not `text`: the pointer is envelope-encrypted by
 * `svc-crypto` before every INSERT/UPDATE (kernel `CryptoClient`, matching
 * `leave.leave_request.attachment_ref`'s pattern for the same reason — a
 * receipt photo is uncontrolled user content and can contain medical
 * information the employee happened to photograph, e.g. a pharmacy
 * receipt itemising a prescription). `claims-schema.test.ts` enumerates
 * every `bytea` column in this schema explicitly, so a future migration
 * that adds a second one (or quietly widens this one to `text`) fails the
 * build rather than merely being missed in review.
 *
 * `claim.amount_thb` and `receipt.vat_amount` are both `numeric`, never
 * `real`/`double precision`. These figures become a reimbursement line
 * inside a payroll run — and per Statutory Spec §10 (s.76 deduction
 * whitelist interaction) that line is **non-taxable, kept out of the tax
 * and Social Security wage base**. A float rounding error in either
 * column is not a display glitch: it either over/under-taxes the
 * employee or misstates the employer's SSO filing. `claims-schema.test.ts`
 * asserts each column's type by name and demonstrates the assertion
 * failing when one is changed to `double precision`.
 *
 * `claim.dup_hash` (amount+date+vendor, per DATABASE-DESIGN.md §2.4) is
 * the mechanism M6-5's duplicate-receipt detection runs against — the
 * same receipt submitted twice. It is explicitly INDEXED here, not just
 * present: without an index, checking a new claim against every existing
 * `dup_hash` degenerates to a sequential scan that gets silently skipped
 * (or simply timed out) under load, defeating the control it exists to
 * enforce. `claims-schema.test.ts` demonstrates the index-presence
 * assertion failing when the index is removed from this migration, so the
 * requirement stays load-bearing rather than decorative.
 *
 * `claim.status` carries a CHECK constraint enumerating exactly the six
 * ERD states (`draft|pending|approved|for_payroll|paid_offcycle|
 * rejected`). The `for_payroll` vs `paid_offcycle` distinction is what
 * routes money — the former rides the next regular payroll run as a
 * non-taxable line, the latter pays out through an off-cycle bank-file
 * batch outside any run — so it must be a constrained value a CHECK can
 * reject, not free text a typo could silently corrupt.
 *
 * Business logic — submission, approval banding, limit enforcement,
 * duplicate rejection, reimbursement routing — is explicitly out of scope
 * for this task (Task 14 brief: "Phase 4 owns those"). This migration
 * exists so the shape is right before any of that code is written, not to
 * implement it.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 14 brief CONSTRAINTS, matching Tasks 7/8/9/13/14's
 * precedent); a later integration task re-proves this against real
 * Postgres.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('claims', { ifNotExists: true })

  pgm.createTable(
    { schema: 'claims', name: 'claim' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: { type: 'uuid', notNull: true },
      claim_type: { type: 'text', notNull: true },
      // numeric, never real/double precision — see file-level comment:
      // this figure becomes a non-taxable payroll line, out of the tax
      // and SSO wage base, so a float rounding error here is a payroll
      // error and a wrong statutory filing.
      amount_thb: { type: 'numeric', notNull: true },
      status: { type: 'text', notNull: true, default: 'draft' },
      // amount+date+vendor hash (DATABASE-DESIGN.md §2.4). Nullable:
      // populated at submission (M6-2), not present on a draft. Indexed
      // below — see file-level comment on why the index is the point.
      dup_hash: { type: 'text' },
    },
  )
  // Task 16c fix: node-pg-migrate's `createTable` `constraints` option is
  // keyed by CONSTRAINT KIND, not by a chosen name — the previous
  // `{ constraints: { claim_status_check: { check: ... } } }` nested the
  // name one level too deep, so node-pg-migrate's `parseConstraints` found
  // no recognised kind and silently created nothing. This service has never
  // been deployed, so the fix is an in-place edit; `pgm.addConstraint` is
  // used so the name matches this file's own prior comments verbatim.
  pgm.addConstraint({ schema: 'claims', name: 'claim' }, 'claim_status_check', {
    check: "status IN ('draft', 'pending', 'approved', 'for_payroll', 'paid_offcycle', 'rejected')",
  })
  pgm.createIndex({ schema: 'claims', name: 'claim' }, ['employee_id'])
  // The load-bearing index for M6-5 duplicate-receipt detection — see the
  // file-level comment. `claims-schema.test.ts` demonstrates the
  // assertion for this index failing when it is removed.
  pgm.createIndex({ schema: 'claims', name: 'claim' }, ['dup_hash'], { name: 'claim_dup_hash_idx' })

  pgm.sql(`COMMENT ON COLUMN claims.claim.status IS
    'Six ERD states only: draft, pending, approved, for_payroll, paid_offcycle, rejected. for_payroll vs paid_offcycle routes money (next payroll run, non-taxable line, vs an off-cycle bank-file batch) -- must stay a CHECK-constrained value, never free text.'`)

  pgm.createTable(
    { schema: 'claims', name: 'receipt' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      claim_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'claims', name: 'claim' },
        referencesConstraintName: 'receipt_claim_id_fkey',
      },
      // The one legitimate bytea column in this schema — see the
      // file-level comment and `claims-schema.test.ts`'s explicit
      // enumeration test. Points at a MinIO object (a receipt photo/PDF);
      // the pointer itself is envelope-encrypted by svc-crypto before
      // every INSERT/UPDATE, never written in the clear. A receipt is
      // uncontrolled user content and can incidentally contain medical
      // information (e.g. a pharmacy receipt itemising a prescription).
      file_ref: { type: 'bytea', notNull: true },
      // numeric, never real/double precision — see file-level comment.
      // Nullable: not every claim type's receipt carries VAT (e.g.
      // mileage has no receipt at all in the strict sense; per-diem
      // receipts may be VAT-exempt).
      vat_amount: { type: 'numeric' },
    },
  )
  pgm.createIndex({ schema: 'claims', name: 'receipt' }, ['claim_id'])

  pgm.sql(`COMMENT ON COLUMN claims.receipt.file_ref IS
    'Pointer to a receipt photo/PDF in MinIO -- uncontrolled user content that can incidentally contain medical information. Always envelope-encrypted by svc-crypto before INSERT/UPDATE -- never written in the clear (Security doc section 3). Must remain bytea; never text.'`)

  // Shared per-schema APPROVAL_STEP pattern (DATABASE-DESIGN.md §2.4
  // closing note), named approval_step2 to match the ERD's mermaid node
  // id for this schema's copy. `subject_id` carries no FK — see
  // file-level comment for why that matches `leave.approval_step`'s
  // precedent exactly.
  pgm.createTable(
    { schema: 'claims', name: 'approval_step2' },
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
  )
  pgm.addConstraint(
    { schema: 'claims', name: 'approval_step2' },
    'approval_step2_decision_check',
    { check: "decision IS NULL OR decision IN ('approved', 'rejected')" },
  )
  pgm.createIndex({ schema: 'claims', name: 'approval_step2' }, ['subject_id', 'level'])

  // Read model fed by `employee.*` events (DATABASE-DESIGN.md §1) — no
  // `references` to `onboarding.employee`: cross-schema foreign keys are
  // disallowed by convention (each service's DB role can see only its own
  // schema; a cross-schema FK would not even be enforceable by every
  // role). Populated by a future `idempotent()`-driven consumer, not by
  // this migration.
  pgm.createTable(
    { schema: 'claims', name: 'claims_employee_ref' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      status: { type: 'text', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )

  pgm.createTable(
    { schema: 'claims', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'claims', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (roadmap "Database conventions").
  pgm.createTable(
    { schema: 'claims', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  pgm.dropSchema('claims', { cascade: true, ifExists: true })
}
