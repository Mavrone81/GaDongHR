'use strict'

/**
 * `scheduler` schema — DATABASE-DESIGN §2.3, exactly:
 *
 *   scheduler.shift(id uuid pk, name_i18n jsonb, start_t time, end_t time,
 *     crosses_midnight bool, break_rules jsonb, grace_min int, differential jsonb)
 *   scheduler.roster_entry(id uuid pk, employee_id uuid, shift_id uuid fk,
 *     work_date date, status text, override_reason text null)
 *   scheduler.holiday_calendar(id uuid pk, year int)
 *   scheduler.holiday(id uuid pk, calendar_id uuid fk, holiday_date date,
 *     name_i18n jsonb, is_substitute bool, substitute_for_id uuid fk null)
 *   scheduler.ot_request(id uuid pk, employee_id uuid, ot_date date,
 *     hours numeric, rate_class text, status text, approved_by uuid)
 *
 * Plus the two tables every schema carries: `outbox` and
 * `processed_events(event_id PK)` (global-constraints; roadmap "Database
 * conventions"), and `scheduler_employee_ref` — this service's local,
 * eventually-consistent copy of the `employee.*` fields it needs, fed by a
 * Phase 3 event consumer. `gen_random_uuid()` is built into Postgres core
 * since 13 — no `pgcrypto` extension needed on Postgres 16.
 *
 * **No foreign keys across schemas** (roadmap "Database conventions": "No
 * foreign keys across schemas. No cross-schema queries."). `roster_entry`
 * and `ot_request` carry `employee_id` as a bare `uuid` column with no
 * `references` at all — not even an in-schema FK to `scheduler_employee_ref`
 * — matching `services/svc-notify`'s `notify.recipient_pref` precedent:
 * the read model is populated asynchronously from `employee.*` events, so a
 * roster entry or OT request can legitimately arrive (and must not be
 * rejected) before its employee's ref row has landed. An FK here would
 * turn ordinary event-delivery lag into a write failure. `shift_id`,
 * `calendar_id`, and `substitute_for_id` DO get real FKs: those targets
 * (`shift`, `holiday_calendar`, `holiday`) are owned and written
 * transactionally by this same service, so there is no cross-schema or
 * eventual-consistency concern for them.
 *
 * Data classification (roadmap "data classification"; Security doc §3):
 * this entire schema is S1 (internal) — the DATABASE-DESIGN §2.3 ERD box
 * carries no 🔐 markers anywhere, unlike the M1 people-of-record schema's
 * EMPLOYEE table or `payroll.PAYSLIP`. Columns considered for encryption
 * and rejected:
 *   - `employee_id` / `approved_by` (uuid, opaque identifiers, not PII
 *     themselves — every other schema in the ERD carries `employee_id`
 *     unencrypted the same way, e.g. `attendance.PUNCH_EVENT.employee_id`).
 *   - `roster_entry.override_reason` (free text) — an operational note
 *     ("covering for X's rest day", "leave-collision override") not a
 *     designated PII field; encrypting it would make rosters unqueryable
 *     for managers for no compliance benefit the spec asks for.
 *   - `shift.name_i18n` / `break_rules` / `differential` — shift
 *     definitions and pay-differential rules, operational data, not
 *     personal data.
 * Nothing here is a national ID, bank detail, or biometric — the categories
 * that earn 🔐 elsewhere in this design. Over-encrypting S1 data was
 * explicitly the thing to avoid (Task 14 brief).
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 14 brief CONSTRAINTS); a later integration task runs this for
 * real, the same deferral `services/svc-config`'s migration documents.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('scheduler', { ifNotExists: true })

  pgm.createTable(
    { schema: 'scheduler', name: 'shift' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      name_i18n: { type: 'jsonb', notNull: true },
      start_t: { type: 'time', notNull: true },
      end_t: { type: 'time', notNull: true },
      // The case that breaks naive time handling: a shift like 22:00–06:00
      // where `end_t < start_t` means "next day", not "invalid range" — this
      // column is the flag Phase 3's duration/OT math branches on instead of
      // inferring it from comparing `start_t`/`end_t` (Task 14 brief).
      crosses_midnight: { type: 'boolean', notNull: true, default: false },
      break_rules: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
      grace_min: { type: 'integer', notNull: true, default: 0 },
      // Nullable: not every shift carries a pay differential (e.g. night/holiday loading).
      differential: { type: 'jsonb' },
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
  // file's own prior comments verbatim.
  pgm.addConstraint({ schema: 'scheduler', name: 'shift' }, 'shift_grace_min_check', {
    check: 'grace_min >= 0',
  })

  pgm.createTable(
    { schema: 'scheduler', name: 'holiday_calendar' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      year: { type: 'integer', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint(
    { schema: 'scheduler', name: 'holiday_calendar' },
    'holiday_calendar_year_key',
    { unique: ['year'] },
  )

  pgm.createTable(
    { schema: 'scheduler', name: 'holiday' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      calendar_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'scheduler', name: 'holiday_calendar' },
        referencesConstraintName: 'holiday_calendar_id_fkey',
        onDelete: 'CASCADE',
      },
      holiday_date: { type: 'date', notNull: true },
      name_i18n: { type: 'jsonb', notNull: true },
      is_substitute: { type: 'boolean', notNull: true, default: false },
      // Self-referencing: the substitute day this row stands in for, when
      // `is_substitute` is true (M2-SCHEDULER §1.3: a holiday falling on an
      // employee's weekly rest day gets an auto-created substitute on the
      // next working day). Null for an ordinary (non-substitute) holiday.
      substitute_for_id: {
        type: 'uuid',
        references: { schema: 'scheduler', name: 'holiday' },
        referencesConstraintName: 'holiday_substitute_for_id_fkey',
      },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint(
    { schema: 'scheduler', name: 'holiday' },
    'holiday_calendar_id_holiday_date_key',
    { unique: ['calendar_id', 'holiday_date'] },
  )
  pgm.createIndex({ schema: 'scheduler', name: 'holiday' }, ['calendar_id'])

  // Local read model of `employee.*` events (roadmap "Database conventions":
  // "employee_id is replicated into per-schema *_employee_ref read models
  // via employee.* events"). Deliberately minimal — just enough for a
  // roster/OT screen to show a name and know whether the employee is still
  // active — the consumer that populates it is Phase 3, not this task.
  pgm.createTable(
    { schema: 'scheduler', name: 'scheduler_employee_ref' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      emp_code: { type: 'text' },
      status: { type: 'text' },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )

  pgm.createTable(
    { schema: 'scheduler', name: 'roster_entry' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // No `references` here — see file header: this is a bare uuid, not an
      // FK, deliberately (no cross-schema FK to the M1 people-of-record
      // employee table, and no in-schema FK to scheduler_employee_ref
      // either, for the same eventual-consistency reason
      // `notify.recipient_pref` establishes).
      employee_id: { type: 'uuid', notNull: true },
      shift_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'scheduler', name: 'shift' },
        referencesConstraintName: 'roster_entry_shift_id_fkey',
      },
      work_date: { type: 'date', notNull: true },
      status: { type: 'text', notNull: true, default: 'planned' },
      // Nullable: only set when a manager overrides a warn-level conflict
      // (leave collision etc.) — Phase 3's RosterPlanner.
      override_reason: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint({ schema: 'scheduler', name: 'roster_entry' }, 'roster_entry_status_check', {
    check: "status IN ('planned', 'published')",
  })
  // Backs "team roster grid for a date range" and "this employee's schedule".
  pgm.createIndex({ schema: 'scheduler', name: 'roster_entry' }, ['employee_id', 'work_date'])
  pgm.createIndex({ schema: 'scheduler', name: 'roster_entry' }, ['shift_id'])

  pgm.createTable(
    { schema: 'scheduler', name: 'ot_request' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // Same reasoning as roster_entry.employee_id above — bare uuid, no FK.
      employee_id: { type: 'uuid', notNull: true },
      ot_date: { type: 'date', notNull: true },
      hours: { type: 'numeric', notNull: true },
      // What payroll multiplies by: 1.5x workday, 2x holiday work, 3x holiday OT.
      rate_class: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'pending' },
      // Nullable: unset until a `schedule.ot.approve` decision is made.
      approved_by: { type: 'uuid' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint({ schema: 'scheduler', name: 'ot_request' }, 'ot_request_hours_check', {
    check: 'hours > 0',
  })
  pgm.addConstraint({ schema: 'scheduler', name: 'ot_request' }, 'ot_request_rate_class_check', {
    check: "rate_class IN ('workday', 'holiday_work', 'holiday_ot')",
  })
  pgm.addConstraint({ schema: 'scheduler', name: 'ot_request' }, 'ot_request_status_check', {
    check: "status IN ('pending', 'approved', 'rejected')",
  })
  pgm.createIndex({ schema: 'scheduler', name: 'ot_request' }, ['employee_id', 'ot_date'])

  pgm.createTable(
    { schema: 'scheduler', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'scheduler', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (matching
  // every other schema's `processed_events` table).
  pgm.createTable(
    { schema: 'scheduler', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  pgm.dropSchema('scheduler', { cascade: true, ifExists: true })
}
