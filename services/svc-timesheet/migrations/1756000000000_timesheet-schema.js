'use strict'

/**
 * `timesheet` schema — DATABASE-DESIGN §2.3, exactly:
 *
 *   timesheet.day_record(id uuid pk, employee_id uuid, work_date date,
 *     roster_entry_id uuid null, actual_in timestamptz, actual_out timestamptz,
 *     worked_hours numeric, late_min numeric, ot_15x numeric, ot_2x numeric,
 *     ot_3x numeric, leave_code text null, status text)
 *   timesheet.time_exception(id uuid pk, day_record_id uuid fk, kind text,
 *     resolution text, resolved_by uuid, reason text)
 *   timesheet.period(id uuid pk, range daterange, status text,
 *     lock_version int, locked_by uuid, locked_at timestamptz)
 *     — range overlap prevented by an EXCLUDE USING gist constraint, not a
 *     plain UNIQUE (see the `period_no_overlap` comment below: fix round 1,
 *     coordinator review, 2026-08-02 — a bare UNIQUE only rejects two
 *     *identical* ranges, not overlapping ones, which leaves `lock_version`
 *     without a defined meaning for a day claimed by two periods at once).
 *
 * Plus the two tables every schema carries — `outbox` and
 * `processed_events(event_id PK)` (roadmap "Database conventions") — and
 * `timesheet_employee_ref`, a local read model of `employee.created` /
 * `employee.updated` (roadmap "Event catalog": `{id, empCode, orgUnitId,
 * employmentType, provinceCode, startDate, status, preferredLang}`),
 * carrying only the fields this service's Phase 3 logic actually needs
 * (OT classification depends on `employment_type` — monthly/daily/hourly —
 * and the manager team view scopes by `org_unit_id`). Mirrors
 * `services/svc-notify`'s `recipient_pref` table: **no foreign keys across
 * schemas** (roadmap "Database conventions" / "Employee identity across
 * services") — `employee_id` here is a plain uuid, not a `REFERENCES`.
 *
 * This task (Task 14) builds schema and health only — no consolidation, OT
 * classification, exception workflow, or period-lock logic. Phase 3 owns
 * that; this migration is its foundation, so every column Phase 3 will read
 * or write already exists with the right type.
 *
 * === Why the three OT columns are separate (not one `ot_hours` + rate) ===
 * `ot_15x`, `ot_2x`, `ot_3x` are the statutory rate classes (workday 1.5×,
 * holiday work 2×, holiday OT 3× — Statutory Spec §4, M3-TIMESHEET.md
 * `OtBreakdown`). Payroll multiplies each independently by the hourly base;
 * a single `ot_hours` total cannot be reconstructed back into classes once
 * collapsed, and a payslip needs all three broken out for the statutory
 * export. Keeping them as three named `numeric` columns (never a single
 * total + a `rate_class` side table) is a schema-level guarantee that this
 * information is never lost between M3 and M7.
 *
 * === Why `numeric`, never `real`/`double precision` ===
 * Hours feed directly into payroll's gross-to-net computation. IEEE 754
 * floats cannot represent values like 7.5 or 1.5× multiples exactly across
 * repeated arithmetic, and a rounding drift here becomes a wrong payslip —
 * the same reasoning DATABASE-DESIGN and the roadmap apply to money
 * ("Money: THB, satang precision in engines... never float"). `worked_hours`,
 * `late_min`, `ot_15x`, `ot_2x`, `ot_3x` are all `numeric` (arbitrary
 * precision, exact decimal arithmetic), never `real` or `double precision`.
 *
 * === Encryption review (roadmap "Data classification → storage treatment") ===
 * Most of this schema is **S1** (internal, plaintext, TLS + volume
 * encryption only) — rosters/shifts/timesheets are operational data, not
 * the S2/S3 categories (names, national ID, bank account, salary, tax,
 * health attachments) DATABASE-DESIGN marks 🔐 elsewhere. Columns
 * considered and rejected for encryption, with reasoning:
 *   - `worked_hours`, `late_min`, `ot_15x`, `ot_2x`, `ot_3x` (numeric hours):
 *     `GET /ot/summary?period&org_unit` (M3-TIMESHEET.md API #11) needs
 *     `SUM()`/`GROUP BY` against these for the 36h OT-ceiling utilisation
 *     view — encrypting a column payroll and compliance need to aggregate
 *     across thousands of rows would make that query impossible without
 *     decrypting every row first. Hours are not wages; DATABASE-DESIGN
 *     marks only `payroll.*`'s computed money fields (`gross`, `net`, …) 🔐,
 *     never the hours that feed them.
 *   - `day_record.actual_in` / `actual_out` (punch timestamps): DATABASE-
 *     DESIGN §2.2 does not mark `PUNCH_EVENT.punched_at` 🔐 either — a
 *     clock time is operational, not identifying, on its own. Encrypting
 *     it would block the date-range scans (`GET /my/days?from&to`, period
 *     lock's date-range membership check) this table exists to serve.
 *   - `time_exception.reason` (free text): could in principle carry
 *     incidental personal detail (e.g. "stuck in traffic", "sick"), but it
 *     is an operational HR workflow note, not classified S2/S3 in
 *     DATABASE-DESIGN (contrast `leave.LEAVE_REQUEST.attachment_ref`,
 *     which explicitly IS 🔐 for medical certificates). The exception
 *     queue (`GET /exceptions?status&org_unit`) is a manager/HR triage
 *     list view — encrypting `reason` would force a decrypt round trip per
 *     row just to render the queue. If a specific exception genuinely
 *     needs a sensitive attachment, that already has its own encrypted
 *     channel (`leave`/`claims` `*_ref` pointers), not this field.
 *   - `timesheet_employee_ref.emp_code` / `org_unit_id` / `employment_type`
 *     / `status`: sourced only from `employee.created`/`employee.updated`,
 *     whose payload is deliberately non-sensitive (roadmap: "Events never
 *     carry sensitive plaintext") — `svc-onboarding`'s own 🔐 fields
 *     (name, national ID, DOB, …) are never emitted onto the bus at all, so
 *     there is no plaintext-sensitive data in this read model to encrypt.
 *   - `resolved_by` / `locked_by` (uuid actor references): bare identifiers,
 *     not personal data by themselves — DATABASE-DESIGN never marks an
 *     `*_by uuid` column 🔐 anywhere in the ERD.
 * Over-encrypting this table would make routine aggregation and range
 * queries unworkable for no PDPA benefit — the standing instruction not to
 * encrypt what does not need it.
 *
 * `gen_random_uuid()` is built into Postgres core since 13 — no `pgcrypto`
 * extension needed on Postgres 16 (matches `services/svc-config`'s
 * migration note).
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 14 brief CONSTRAINTS, matching every other service's
 * migration note in this repo); asserted instead in `src/migration.test.ts`
 * against this file's own generated SQL / source text, the same pattern
 * `services/svc-audit/src/migration.test.ts` established.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('timesheet', { ifNotExists: true })

  pgm.createTable(
    { schema: 'timesheet', name: 'day_record' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: { type: 'uuid', notNull: true },
      work_date: { type: 'date', notNull: true },
      roster_entry_id: { type: 'uuid' },
      actual_in: { type: 'timestamptz' },
      actual_out: { type: 'timestamptz' },
      worked_hours: { type: 'numeric', notNull: true, default: 0 },
      late_min: { type: 'numeric', notNull: true, default: 0 },
      ot_15x: { type: 'numeric', notNull: true, default: 0 },
      ot_2x: { type: 'numeric', notNull: true, default: 0 },
      ot_3x: { type: 'numeric', notNull: true, default: 0 },
      leave_code: { type: 'text' },
      status: { type: 'text', notNull: true, default: 'ok' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      // Deliberately NO foreign key to any other schema — `employee_id` is
      // a plain uuid replicated via `employee.*` events, not a
      // cross-schema `REFERENCES` (roadmap "Database conventions": "No
      // foreign keys across schemas. No cross-schema queries."). Nor is
      // there a `period_id` FK: DATABASE-DESIGN §2.3's `DAY_RECORD }o--||
      // PERIOD : in` relationship is resolved by `work_date` falling
      // inside `period.range`, not by a stored key — the ERD's own
      // `DAY_RECORD` attribute block lists no `period_id` column.
      constraints: {
        // "One daily record per employee" (Task 14 brief, "WHY THIS
        // SERVICE MATTERS") — the merge engine's whole job is to produce
        // exactly one row per employee-day from punches+roster+leave.
        day_record_employee_id_work_date_key: { unique: ['employee_id', 'work_date'] },
        day_record_status_check: { check: "status IN ('ok', 'exception', 'corrected')" },
        day_record_worked_hours_check: { check: 'worked_hours >= 0' },
        day_record_late_min_check: { check: 'late_min >= 0' },
        day_record_ot_15x_check: { check: 'ot_15x >= 0' },
        day_record_ot_2x_check: { check: 'ot_2x >= 0' },
        day_record_ot_3x_check: { check: 'ot_3x >= 0' },
        // Physical invariant, not business logic: a punch-out cannot
        // precede its punch-in. Both are full `timestamptz`, so this holds
        // across a midnight-crossing shift without any date-only special
        // case.
        day_record_actual_out_after_in_check: {
          check: 'actual_in IS NULL OR actual_out IS NULL OR actual_out > actual_in',
        },
      },
    },
  )
  // Backs `GET /my/days?from&to`, `GET /teams/{orgUnit}/days?from&to` and
  // `GET /days/{employeeId}?from&to` (M3-TIMESHEET.md API #1-3) and the
  // period lock guard's date-range scan.
  pgm.createIndex({ schema: 'timesheet', name: 'day_record' }, ['employee_id', 'work_date'])
  pgm.createIndex({ schema: 'timesheet', name: 'day_record' }, ['work_date'])
  // Backs the exception-queue population check at lock time (`TSH-030`).
  pgm.createIndex(
    { schema: 'timesheet', name: 'day_record' },
    ['status'],
    { name: 'day_record_exception_idx', where: "status = 'exception'" },
  )

  pgm.createTable(
    { schema: 'timesheet', name: 'time_exception' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      day_record_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'timesheet', name: 'day_record' },
        referencesConstraintName: 'time_exception_day_record_id_fkey',
        onDelete: 'CASCADE',
      },
      kind: { type: 'text', notNull: true },
      resolution: { type: 'text' },
      resolved_by: { type: 'uuid' },
      reason: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        // M3-TIMESHEET.md §1.1's anomaly list.
        time_exception_kind_check: {
          check: "kind IN ('missed_punch', 'late', 'absence', 'unapproved_ot')",
        },
      },
    },
  )
  // Backs `GET /exceptions?status&org_unit` (M3-TIMESHEET.md API #4).
  pgm.createIndex({ schema: 'timesheet', name: 'time_exception' }, ['day_record_id'])

  pgm.createTable(
    { schema: 'timesheet', name: 'period' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      range: { type: 'daterange', notNull: true },
      status: { type: 'text', notNull: true, default: 'open' },
      lock_version: { type: 'integer', notNull: true, default: 0 },
      locked_by: { type: 'uuid' },
      locked_at: { type: 'timestamptz' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        period_status_check: { check: "status IN ('open', 'locked')" },
        period_lock_version_check: { check: 'lock_version >= 0' },
      },
    },
  )
  pgm.createIndex({ schema: 'timesheet', name: 'period' }, ['status'])

  // Fix round 1 (coordinator review, 2026-08-02): a plain `UNIQUE (range)`
  // — the first version of this migration — only rejects two periods with
  // the *identical* bounds. It does nothing to stop two *different,
  // overlapping* ranges from coexisting, e.g. 2026-08-01..2026-08-31 and
  // 2026-08-15..2026-09-15 can both exist under a bare UNIQUE. Both then
  // contain 2026-08-20, so a `day_record` for that date falls inside two
  // periods at once, and a payroll run pinning `PAYROLL_RUN
  // .timesheet_lock_version` to one of them (roadmap DATABASE-DESIGN
  // §2.5) has no defined answer for which period's lock actually governs
  // that day's hours — a wage dispute with no row in this schema able to
  // resolve it. An `EXCLUDE` constraint using the range-overlap operator
  // (`&&`) rejects the INSERT/UPDATE outright, at the database, the
  // moment it would create that ambiguity — no window exists in which two
  // overlapping periods are both live.
  //
  // `btree_gist` is required for a GiST index/exclusion constraint over a
  // range type at all (GiST needs the `&&`/range operator class it
  // provides); added via `createExtension` (not raw `CREATE EXTENSION`
  // SQL) so it is idempotent the same way `createSchema(...,
  // {ifNotExists:true})` is. Added now, before this table holds any rows,
  // specifically because adding it later against a populated `period`
  // table means an ACCESS EXCLUSIVE lock on the busiest table in the
  // system — cheap now, expensive later.
  //
  // node-pg-migrate has no first-class helper for an `EXCLUDE` constraint
  // (only `UNIQUE`/`CHECK`/`FOREIGN KEY` via `constraints:` /
  // `addConstraint`), so this is raw SQL via `pgm.sql(...)` — the normal
  // way to do this with this migration tool.
  pgm.createExtension('btree_gist', { ifNotExists: true })
  pgm.sql(`
    ALTER TABLE timesheet.period
      ADD CONSTRAINT period_no_overlap
      EXCLUDE USING gist (range WITH &&);
  `)

  // Local read model of `employee.created` / `employee.updated`
  // (roadmap "Event catalog") — see file header for why these columns and
  // no others. Mirrors `services/svc-notify`'s `recipient_pref` table.
  pgm.createTable(
    { schema: 'timesheet', name: 'timesheet_employee_ref' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      emp_code: { type: 'text', notNull: true },
      org_unit_id: { type: 'uuid', notNull: true },
      employment_type: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        timesheet_employee_ref_employment_type_check: {
          check: "employment_type IN ('monthly', 'daily', 'hourly', 'contract')",
        },
        timesheet_employee_ref_status_check: {
          check: "status IN ('onboarding', 'active', 'terminated')",
        },
      },
    },
  )

  pgm.createTable(
    { schema: 'timesheet', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'timesheet', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (matches
  // every other service's migration note in this repo).
  pgm.createTable(
    { schema: 'timesheet', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  // Explicit, ahead of the schema drop below: `dropSchema(..., {cascade:
  // true})` would take the constraint with it anyway, but naming the drop
  // here makes it a written statement (matching this file's own
  // `day_record`/`period` CHECK constraints, which are likewise dropped
  // implicitly by the schema cascade but are never relied on to vanish
  // silently) rather than an assumption resting on cascade behaviour.
  // `btree_gist` is deliberately NOT dropped here — it is a cluster-wide
  // extension other schemas may also depend on; tearing down one
  // service's schema must never remove a shared Postgres extension.
  pgm.sql('ALTER TABLE IF EXISTS timesheet.period DROP CONSTRAINT IF EXISTS period_no_overlap;')
  pgm.dropSchema('timesheet', { cascade: true, ifExists: true })
}
