'use strict'

/**
 * Phase 3 (M2) extension to the Task 14 schema — adds exactly the columns
 * and one new table Phase 3's business logic needs that Task 14's schema
 * (DATABASE-DESIGN §2.3, verbatim) did not carry:
 *
 *   - `scheduler.roster_entry.hazardous` — the manager-set flag
 *     `GuardrailPolicy` reads to pick the 42h (not 48h) weekly ceiling
 *     (Statutory Spec §4: "48 (42 hazardous)"). Per-assignment, not
 *     per-employee: no event in the roadmap's catalog (`employee.created`'s
 *     payload has no hazardous field) carries this, so it is something a
 *     manager declares at roster time, not inferred from a read model this
 *     service does not own.
 *   - `scheduler.ot_request.reason` / `.employee_consent` / `.decision_reason`
 *     — the API manual's `POST /ot-requests` body is
 *     `{date, hours, rateClass, reason, employeeConsent}` (M2-SCHEDULER
 *     §3, row 7) and LPA s.24 requires consent per instance
 *     (`ot.consent` — Statutory Spec §4); `decision_reason` records why an
 *     approver rejected a request (mirrors `roster_entry.override_reason`'s
 *     nullable-until-decided shape).
 *   - `scheduler.scheduler_employee_ref.org_unit_id` — `employee.created`/
 *     `.updated`'s payload carries `orgUnitId` (roadmap "Event catalog");
 *     replicating it here is what lets `GET /rosters?org_unit=` filter
 *     without a cross-schema query (both tables live in `scheduler`).
 *   - `scheduler.leave_ref` — the local, eventually-consistent read model
 *     `LeaveReadModel.isOnLeave(emp, date)` (M2-SCHEDULER §2 class diagram)
 *     is built from, fed by `leave.approved`/`leave.cancelled` events. Same
 *     no-FK reasoning as `roster_entry.employee_id`/`ot_request.employee_id`
 *     (Task 14 migration header): `employee_id` here is a bare uuid.
 *
 * Additive only — no column on the Task 14 tables is renamed, retyped, or
 * dropped, so every one of `migration.test.ts`'s existing assertions about
 * that file keeps passing unmodified. This file's own coverage lives in
 * `migration-m2-extensions.test.ts`, following the same
 * `MigrationBuilderImpl`-based "prove the real generated SQL, not just the
 * source text" approach Task 16c established (see Task 14's
 * `migration.test.ts` header) for every constraint asserted below.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — brief CONSTRAINTS); the table this service has never been deployed
 * to makes an additive migration file, not an in-place edit of the Task 14
 * file, the safer default here regardless.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.addColumns(
    { schema: 'scheduler', name: 'roster_entry' },
    {
      // Selects the 42h (not 48h) weekly ceiling in GuardrailPolicy — see
      // file header. Declared at assignment time, defaults to the common
      // (non-hazardous) case.
      hazardous: { type: 'boolean', notNull: true, default: false },
    },
  )

  pgm.addColumns(
    { schema: 'scheduler', name: 'ot_request' },
    {
      reason: { type: 'text', notNull: true, default: '' },
      // LPA s.24: OT requires the employee's consent per instance.
      employee_consent: { type: 'boolean', notNull: true, default: false },
      // Set only on a reject decision — mirrors roster_entry.override_reason's shape.
      decision_reason: { type: 'text' },
    },
  )

  pgm.addColumns(
    { schema: 'scheduler', name: 'scheduler_employee_ref' },
    {
      // From employee.created/.updated's payload — backs org-unit-scoped
      // roster grid queries without a cross-schema join.
      org_unit_id: { type: 'uuid' },
    },
  )

  pgm.createTable(
    { schema: 'scheduler', name: 'leave_ref' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // No `references` — same no-cross-schema/no-eventual-consistency-trap
      // reasoning as roster_entry.employee_id (Task 14 migration header).
      employee_id: { type: 'uuid', notNull: true },
      // From leave.approved/.cancelled's `requestId` — the natural key this
      // read model dedupes on so a later `leave.cancelled` for the same
      // request updates the row `leave.approved` created, rather than
      // inserting a second one.
      leave_request_id: { type: 'text', notNull: true },
      date_from: { type: 'date', notNull: true },
      date_to: { type: 'date', notNull: true },
      status: { type: 'text', notNull: true, default: 'approved' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint({ schema: 'scheduler', name: 'leave_ref' }, 'leave_ref_leave_request_id_key', {
    unique: ['leave_request_id'],
  })
  pgm.addConstraint({ schema: 'scheduler', name: 'leave_ref' }, 'leave_ref_status_check', {
    check: "status IN ('approved', 'cancelled')",
  })
  pgm.createIndex({ schema: 'scheduler', name: 'leave_ref' }, ['employee_id'])
}

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'scheduler', name: 'leave_ref' })
  pgm.dropColumns({ schema: 'scheduler', name: 'scheduler_employee_ref' }, ['org_unit_id'])
  pgm.dropColumns({ schema: 'scheduler', name: 'ot_request' }, ['reason', 'employee_consent', 'decision_reason'])
  pgm.dropColumns({ schema: 'scheduler', name: 'roster_entry' }, ['hazardous'])
}
