'use strict'

/**
 * `payroll` schema — Task 14 brief, DATABASE-DESIGN.md §2.5, exactly:
 *
 *   payroll.pay_profile(id uuid pk, employee_id uuid UNIQUE, base_pay bytea,
 *     pay_basis text, recurring_items jsonb, pf_rate bytea null,
 *     tax_allowance_decl bytea null)
 *   payroll.payroll_run(id uuid pk, period text, run_type text,
 *     timesheet_lock_version int, status text, prepared_by uuid,
 *     approved_by uuid null "must differ (SoD)", rulepack_versions jsonb)
 *   payroll.payslip(id uuid pk, run_id uuid fk -> payroll_run, employee_id uuid,
 *     gross bytea, sso_emp bytea, ewf_emp bytea, pf_emp bytea, tax_wht bytea,
 *     net bytea, ytd bytea, pdf_ref bytea)
 *   payroll.pay_item(id uuid pk, payslip_id uuid fk -> payslip, kind text,
 *     amount bytea) — the ERD's PAY_PROFILE.recurring_items comment ("refs,
 *     amounts 🔐 in items table") and PAYSLIP ||--o{ PAY_ITEM : itemises
 *     relation both point at this table holding the itemised, per-line
 *     encrypted amount a payslip's gross breaks down into (base pay, OT,
 *     allowances, statutory deductions, ...). DATABASE-DESIGN.md §2.5 gives
 *     PAY_ITEM only the relation, not a field box the way the other four
 *     tables get one — `amount` is this task's inference of the minimal
 *     shape that relation implies, encrypted for the same reason every
 *     other money column here is (Task 14 brief: "A salary in plaintext
 *     defeats the product's central claim"). It is NOT one of the money
 *     columns the Task 14 brief enumerates by name (those are exactly the
 *     12 on PAY_PROFILE/PAYSLIP/STATUTORY_EXPORT), but `payroll-
 *     schema.test.ts`'s exhaustive bytea enumeration includes it anyway —
 *     omitting a real money column from that list to make the brief's
 *     literal enumeration match would be exactly the plaintext-salary gap
 *     the test exists to catch.
 *   payroll.statutory_export(id uuid pk, run_id uuid fk -> payroll_run,
 *     kind text, file_ref bytea, status text)
 *
 * Plus the two tables every schema carries: `outbox` and
 * `processed_events(event_id PK)` (roadmap "Database conventions"), and
 * `payroll_employee_ref` — this service's local, eventually-consistent copy
 * of the `employee.*` fields it needs (DATABASE-DESIGN.md §1: "employee_id
 * is replicated into per-schema *_employee_ref read models via employee.*
 * events ... no foreign keys across schemas"), matching
 * `services/svc-attendance`'s `attendance_employee_ref` and
 * `services/svc-scheduler`'s `scheduler_employee_ref` precedent exactly.
 * `gen_random_uuid()` is built into Postgres core since 13 — no `pgcrypto`
 * extension needed on Postgres 16.
 *
 * ---------------------------------------------------------------------
 * WHY THIS FILE IS THE SAFETY BOUNDARY FOR M7 (Task 14 brief, "why this
 * service matters"):
 *
 * M7 holds every salary, bank account, tax declaration and payslip in the
 * product, and is where two legal controls live. Both are enforced here,
 * at the database, not only in service code, because — per the brief —
 * "the constraint is what survives a future bug":
 *
 * 1. SEGREGATION OF DUTIES: `payroll_run_sod_check`
 *    (`CHECK (approved_by IS NULL OR approved_by <> prepared_by)`, verbatim
 *    from the Task 14 brief) — the person who prepared a run may not
 *    approve it. `prepared_by` is `notNull`: a run always has a preparer
 *    from the moment it exists; `approved_by` starts `NULL` and is only
 *    ever set by a *different* user. This is the DB "belt" — the service
 *    layer's own equivalent check ("brace") is Phase 5's job, matching how
 *    `services/svc-config`'s `statutory_rule_sod_check` and
 *    `services/svc-authz`'s `role_permission_no_biometric_check` are each
 *    one half of a two-layer control. `payroll-schema.test.ts` demonstrates
 *    this check failing (via source mutation, since there is no Postgres
 *    here to violate it against directly — Task 14 brief CONSTRAINTS).
 *
 * 2. IMMUTABILITY OF COMMITTED RUNS: a committed run is evidence in a wage
 *    dispute and must never be editable (DATABASE-DESIGN.md §2.5's closing
 *    note; Task 14 brief). Two `BEFORE UPDATE OR DELETE` triggers enforce
 *    this — `payroll_run_immutable_when_committed` on `payroll_run` itself
 *    (raises when `OLD.status = 'committed'`), and
 *    `payslip_immutable_when_run_committed` on `payslip` (raises when the
 *    row's `run_id` points at a committed run) — exactly the two targets
 *    the brief names ("a payroll_run row whose status = 'committed' ... and
 *    on any child payslip of such a run"). Corrections happen through a new
 *    `adjustment` run (one of `run_type`'s allowed values), never by
 *    editing history. `pay_item` and `statutory_export` are one hop further
 *    removed (children of `payslip` / siblings of it under `payroll_run`
 *    respectively) and are deliberately left outside this task's trigger
 *    scope — the brief names exactly `payroll_run` and its child
 *    `payslip`; extending immutability further is a decision for whoever
 *    builds the correction/adjustment flow in Phase 5, not one to make
 *    silently here.
 *
 * Do NOT implement gross-to-net, the tax engine, payslip rendering or
 * exports here — Phase 5 owns those (Task 14 brief). This migration exists
 * so the shape and both DB-level controls are right before any of that
 * lands.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 14 brief CONSTRAINTS, matching Tasks 7/8/9/14's precedent); a
 * later integration task re-proves this against real Postgres.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('payroll', { ifNotExists: true })

  pgm.createTable(
    { schema: 'payroll', name: 'pay_profile' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // No `references` — bare uuid, no FK across schemas and no in-schema
      // FK to `payroll_employee_ref` either, matching
      // `scheduler.roster_entry.employee_id`'s precedent: the read model is
      // populated asynchronously from `employee.*` events, so a profile can
      // legitimately be created before its employee's ref row lands.
      employee_id: { type: 'uuid', notNull: true },
      // 🔐 S3 — envelope-encrypted by svc-crypto before every INSERT/UPDATE.
      base_pay: { type: 'bytea', notNull: true },
      pay_basis: { type: 'text', notNull: true },
      recurring_items: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
      // 🔐 S3, nullable: not every employee participates in the provident fund.
      pf_rate: { type: 'bytea' },
      // 🔐 S3, nullable: a freshly onboarded employee may not have filed ล.ย.01 yet.
      tax_allowance_decl: { type: 'bytea' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  // Task 16c fix: node-pg-migrate's `createTable` `constraints` option is
  // keyed by CONSTRAINT KIND, not by a chosen name — the previous shape
  // nested each name one level too deep, so node-pg-migrate's
  // `parseConstraints` found no recognised kind and silently created
  // nothing. This service has never been deployed, so the fix is an
  // in-place edit; `pgm.addConstraint` is used so each name matches this
  // file's own prior comments/tests verbatim.
  pgm.addConstraint({ schema: 'payroll', name: 'pay_profile' }, 'pay_profile_employee_id_key', {
    unique: ['employee_id'],
  })
  pgm.addConstraint({ schema: 'payroll', name: 'pay_profile' }, 'pay_profile_pay_basis_check', {
    check: "pay_basis IN ('monthly', 'daily', 'hourly')",
  })

  pgm.sql(`COMMENT ON COLUMN payroll.pay_profile.base_pay IS
    'S3-classified salary figure. Always envelope-encrypted by svc-crypto before INSERT/UPDATE -- never written in the clear (Task 14 brief: "A salary in plaintext defeats the product''s central claim").'`)

  pgm.createTable(
    { schema: 'payroll', name: 'payroll_run' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      period: { type: 'text', notNull: true },
      run_type: { type: 'text', notNull: true },
      // Binds this run to the exact hours it consumed — the value it must
      // match is `scheduler.period.lock_version` at the moment this run was
      // prepared (cross-schema by convention only: replicated in, never a
      // live FK — see DATABASE-DESIGN.md §1).
      timesheet_lock_version: { type: 'integer', notNull: true },
      status: { type: 'text', notNull: true, default: 'draft' },
      // Always set: a run always has a preparer from the moment it exists —
      // load-bearing for the SoD check below (NULL on this side would make
      // the check vacuously true for every run).
      prepared_by: { type: 'uuid', notNull: true },
      // Nullable: unset until a *different* user approves. See the SoD
      // check below — this is the DB "belt" for that legal control.
      approved_by: { type: 'uuid' },
      rulepack_versions: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint({ schema: 'payroll', name: 'payroll_run' }, 'payroll_run_run_type_check', {
    check: "run_type IN ('regular', 'offcycle', 'adjustment', 'final_pay')",
  })
  pgm.addConstraint({ schema: 'payroll', name: 'payroll_run' }, 'payroll_run_status_check', {
    check: "status IN ('draft', 'calculated', 'reviewed', 'approved', 'committed')",
  })
  pgm.addConstraint(
    { schema: 'payroll', name: 'payroll_run' },
    'payroll_run_timesheet_lock_version_check',
    { check: 'timesheet_lock_version >= 0' },
  )
  // Segregation of duties (Task 14 brief, verbatim): the preparer and
  // approver of one run must be different people. This is the DB "belt" —
  // Phase 5's service layer carries the equivalent "brace".
  // `payroll-schema.test.ts` demonstrates this failing when removed.
  pgm.addConstraint({ schema: 'payroll', name: 'payroll_run' }, 'payroll_run_sod_check', {
    check: 'approved_by IS NULL OR approved_by <> prepared_by',
  })
  pgm.createIndex({ schema: 'payroll', name: 'payroll_run' }, ['period', 'status'])

  pgm.createTable(
    { schema: 'payroll', name: 'payslip' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // In-schema FK — legitimate: `payroll_run` is owned and written
      // transactionally by this same service (unlike `employee_id` below).
      run_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'payroll', name: 'payroll_run' },
        referencesConstraintName: 'payslip_run_id_fkey',
      },
      // Bare uuid — same cross-schema/eventual-consistency reasoning as
      // `pay_profile.employee_id` above.
      employee_id: { type: 'uuid', notNull: true },
      // Every money column on this table is 🔐 S3, envelope-encrypted by
      // svc-crypto before every INSERT/UPDATE — enumerated explicitly in
      // `payroll-schema.test.ts` so a future plaintext money column fails
      // the build.
      gross: { type: 'bytea', notNull: true },
      sso_emp: { type: 'bytea', notNull: true },
      ewf_emp: { type: 'bytea', notNull: true },
      pf_emp: { type: 'bytea', notNull: true },
      tax_wht: { type: 'bytea', notNull: true },
      net: { type: 'bytea', notNull: true },
      ytd: { type: 'bytea', notNull: true },
      pdf_ref: { type: 'bytea', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.createIndex({ schema: 'payroll', name: 'payslip' }, ['run_id'])
  pgm.createIndex({ schema: 'payroll', name: 'payslip' }, ['employee_id'])

  pgm.createTable(
    { schema: 'payroll', name: 'pay_item' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // In-schema FK — `payslip` is owned by this same service.
      payslip_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'payroll', name: 'payslip' },
        referencesConstraintName: 'pay_item_payslip_id_fkey',
      },
      kind: { type: 'text', notNull: true },
      // 🔐 S3 — see file-level comment: this is where PAY_PROFILE.
      // recurring_items' "amounts in items table" and PAYSLIP's itemised
      // breakdown actually live.
      amount: { type: 'bytea', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.createIndex({ schema: 'payroll', name: 'pay_item' }, ['payslip_id'])

  pgm.createTable(
    { schema: 'payroll', name: 'statutory_export' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // In-schema FK — `payroll_run` is owned by this same service.
      run_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'payroll', name: 'payroll_run' },
        referencesConstraintName: 'statutory_export_run_id_fkey',
      },
      kind: { type: 'text', notNull: true },
      // 🔐 S3 — envelope-encrypted MinIO pointer, never a plaintext path,
      // same treatment `docs.document.file_ref` gets.
      file_ref: { type: 'bytea', notNull: true },
      status: { type: 'text', notNull: true, default: 'generated' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint(
    { schema: 'payroll', name: 'statutory_export' },
    'statutory_export_kind_check',
    { check: "kind IN ('sso_1_10', 'pnd1', 'bank_csv', 'pnd1kor', '50bis', 'kor_ror_11')" },
  )
  pgm.addConstraint(
    { schema: 'payroll', name: 'statutory_export' },
    'statutory_export_status_check',
    { check: "status IN ('generated', 'downloaded')" },
  )
  pgm.createIndex({ schema: 'payroll', name: 'statutory_export' }, ['run_id'])

  // Read model fed by `employee.*` events (DATABASE-DESIGN.md §1) — no
  // `references` to `onboarding.employee`: cross-schema foreign keys are
  // disallowed by convention. Populated by a future `idempotent()`-driven
  // consumer, not by this migration (matching `attendance_employee_ref`/
  // `scheduler_employee_ref`'s precedent).
  pgm.createTable(
    { schema: 'payroll', name: 'payroll_employee_ref' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      emp_code: { type: 'text' },
      status: { type: 'text' },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )

  // ---------------------------------------------------------------------
  // Legal control 2: immutability of committed runs (see file header).
  // Two BEFORE triggers, one per target the Task 14 brief names.
  // `RAISE EXCEPTION ... USING ERRCODE = '23514'` reuses Postgres' own
  // "check_violation" SQLSTATE so a caller's error-handling code sees the
  // same class of error a CHECK constraint failure would produce.
  // ---------------------------------------------------------------------

  pgm.sql(`
    CREATE FUNCTION payroll.forbid_committed_run_mutation() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'committed' THEN
        RAISE EXCEPTION 'payroll_run % is committed and immutable -- corrections must go through a new adjustment run', OLD.id
          USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      ELSE
        RETURN NEW;
      END IF;
    END;
    $$ LANGUAGE plpgsql;
  `)

  pgm.sql(`
    CREATE TRIGGER payroll_run_immutable_when_committed
    BEFORE UPDATE OR DELETE ON payroll.payroll_run
    FOR EACH ROW
    EXECUTE FUNCTION payroll.forbid_committed_run_mutation();
  `)

  pgm.sql(`
    CREATE FUNCTION payroll.forbid_committed_run_child_mutation() RETURNS trigger AS $$
    DECLARE
      run_status text;
    BEGIN
      SELECT status INTO run_status FROM payroll.payroll_run WHERE id = OLD.run_id;
      IF run_status = 'committed' THEN
        RAISE EXCEPTION 'payslip % belongs to a committed payroll_run and is immutable -- corrections must go through a new adjustment run', OLD.id
          USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      ELSE
        RETURN NEW;
      END IF;
    END;
    $$ LANGUAGE plpgsql;
  `)

  pgm.sql(`
    CREATE TRIGGER payslip_immutable_when_run_committed
    BEFORE UPDATE OR DELETE ON payroll.payslip
    FOR EACH ROW
    EXECUTE FUNCTION payroll.forbid_committed_run_child_mutation();
  `)

  pgm.createTable(
    { schema: 'payroll', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'payroll', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (matching
  // every other schema's `processed_events` table).
  pgm.createTable(
    { schema: 'payroll', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  // CASCADE also drops the trigger functions above — they live inside the
  // `payroll` schema, same as every table here.
  pgm.dropSchema('payroll', { cascade: true, ifExists: true })
}
