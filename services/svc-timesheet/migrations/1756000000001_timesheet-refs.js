'use strict'

/**
 * Extends the `timesheet` schema (added by `1756000000000_timesheet-schema.js`,
 * Task 14) with the local read models and immutable audit trail Phase 3's
 * consolidation/OT-classification/exception logic needs. This service has
 * never been deployed (Task 14's own migration file note), so this is a new,
 * additive migration rather than an in-place edit of the first one — it
 * leaves every already-tested table/column/constraint in the first migration
 * untouched, matching `services/svc-scheduler`'s own
 * `1756000000001_scheduler-m2-extensions.js`-style precedent of extending
 * rather than rewriting a prior migration.
 *
 * === Why these four tables exist ===
 *
 *  - `roster_ref`: `roster.published` (roadmap event catalog) carries only a
 *    summary (`{rosterId, orgUnitId, dateRange, entryCount}`); this service
 *    treats the accompanying per-entry detail (scheduled shift window,
 *    hazardous flag, whether the date is a public holiday — scheduler owns
 *    the holiday calendar and resolves this at publish time) as the payload
 *    `ConsolidationService.applyRosterEntry` consumes, and persists it here
 *    as a local read model keyed by (employee_id, work_date) — the OT
 *    classifier needs the scheduled window to compute late/early-leave and
 *    the regular-hours threshold, and needs `is_holiday` to route hours into
 *    `ot_2x`/`ot_3x` vs `ot_15x`.
 *  - `leave_ref`: mirrors `services/svc-scheduler`'s own `leave_ref` table
 *    (same reasoning: a durable record of which dates an approved leave
 *    request covers, so `leave.cancelled` can find and clear exactly those
 *    days' `day_record.leave_code` without depending on cross-schema state).
 *  - `ot_approval_ref`: the pre-approval record `OtClassifier` compares
 *    worked OT against — "worked OT without pre-approval is flagged for
 *    manager regularisation, never silently paid or dropped" (M3-2 AC) is
 *    meaningless without a durable record of what WAS approved.
 *  - `correction_audit`: M3-3's "every manual correction stores who, when
 *    and why, immutably" — `time_exception.resolution`/`resolved_by`/`reason`
 *    (Task 14 migration) capture the CURRENT state of an exception, which a
 *    later correction could in principle overwrite; this table is
 *    insert-only (no UPDATE/DELETE statement against it exists anywhere in
 *    this service) and carries a full before/after snapshot, so the audit
 *    trail survives even a second correction to the same day.
 *
 * Encryption review: identical reasoning to the Task 14 migration's own
 * header — none of these columns are S2/S3 (names, national ID, salary,
 * health). `correction_audit.before`/`after` are jsonb snapshots of
 * `day_record` rows, which are themselves S1 (see Task 14 header); `reason`
 * text is an operational HR note, same treatment as `time_exception.reason`.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'timesheet', name: 'roster_ref' },
    {
      employee_id: { type: 'uuid', notNull: true },
      work_date: { type: 'date', notNull: true },
      scheduled_start: { type: 'timestamptz' },
      scheduled_end: { type: 'timestamptz' },
      grace_min: { type: 'integer', notNull: true, default: 0 },
      hazardous: { type: 'boolean', notNull: true, default: false },
      is_holiday: { type: 'boolean', notNull: true, default: false },
      roster_entry_id: { type: 'uuid' },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint(
    { schema: 'timesheet', name: 'roster_ref' },
    'roster_ref_employee_id_work_date_key',
    { primaryKey: ['employee_id', 'work_date'] },
  )
  pgm.addConstraint({ schema: 'timesheet', name: 'roster_ref' }, 'roster_ref_grace_min_check', {
    check: 'grace_min >= 0',
  })

  pgm.createTable(
    { schema: 'timesheet', name: 'leave_ref' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: { type: 'uuid', notNull: true },
      leave_request_id: { type: 'text', notNull: true },
      date_from: { type: 'date', notNull: true },
      date_to: { type: 'date', notNull: true },
      leave_type_code: { type: 'text', notNull: true },
      pay_mode: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'approved' },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint(
    { schema: 'timesheet', name: 'leave_ref' },
    'leave_ref_leave_request_id_key',
    { unique: ['leave_request_id'] },
  )
  pgm.addConstraint({ schema: 'timesheet', name: 'leave_ref' }, 'leave_ref_status_check', {
    check: "status IN ('approved', 'cancelled')",
  })
  pgm.createIndex({ schema: 'timesheet', name: 'leave_ref' }, ['employee_id', 'date_from', 'date_to'])

  pgm.createTable(
    { schema: 'timesheet', name: 'ot_approval_ref' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: { type: 'uuid', notNull: true },
      ot_date: { type: 'date', notNull: true },
      rate_class: { type: 'text', notNull: true },
      hours: { type: 'numeric', notNull: true, default: 0 },
      approved_by: { type: 'uuid' },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint(
    { schema: 'timesheet', name: 'ot_approval_ref' },
    'ot_approval_ref_employee_id_ot_date_key',
    { unique: ['employee_id', 'ot_date'] },
  )
  pgm.addConstraint({ schema: 'timesheet', name: 'ot_approval_ref' }, 'ot_approval_ref_hours_check', {
    check: 'hours >= 0',
  })

  // Immutable audit trail (M3-3): who/when/why + before/after, never
  // updated or deleted by any code path in this service.
  pgm.createTable(
    { schema: 'timesheet', name: 'correction_audit' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      day_record_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'timesheet', name: 'day_record' },
        referencesConstraintName: 'correction_audit_day_record_id_fkey',
        onDelete: 'CASCADE',
      },
      actor: { type: 'uuid', notNull: true },
      at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      reason: { type: 'text', notNull: true },
      before: { type: 'jsonb', notNull: true },
      after: { type: 'jsonb', notNull: true },
    },
  )
  pgm.createIndex({ schema: 'timesheet', name: 'correction_audit' }, ['day_record_id'])
}

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'timesheet', name: 'correction_audit' }, { ifExists: true })
  pgm.dropTable({ schema: 'timesheet', name: 'ot_approval_ref' }, { ifExists: true })
  pgm.dropTable({ schema: 'timesheet', name: 'leave_ref' }, { ifExists: true })
  pgm.dropTable({ schema: 'timesheet', name: 'roster_ref' }, { ifExists: true })
}
