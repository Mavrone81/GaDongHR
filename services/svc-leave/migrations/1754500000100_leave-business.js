'use strict'

/**
 * Phase 4 (this task): the leave-type/balance/request/approval-chain
 * BUSINESS schema — everything 1754500000000_leave-schema.js's file header
 * explicitly deferred ("Business logic ... is explicitly out of scope for
 * this task ... this migration exists so the shape is right before any of
 * that code is written"). This file is that later migration.
 *
 * Deliberately additive-only against the parent migration's four tables —
 * no column in the parent file is renamed, retyped, or dropped, so every
 * assertion `leave-schema.test.ts` already makes (the `bytea` enumeration,
 * the `numeric` enumeration, `statutory_rule_key` nullability, the FK/no-FK
 * shape) continues to hold unchanged; this file's own
 * `leave-business-schema.test.ts` covers only what it adds.
 *
 * WHAT'S HERE AND WHY:
 *
 *  - `leave_type` gains the columns the floor-check/accrual/request engine
 *    actually needs: `entitlement_days` (the value HR can raise but never
 *    lower below its `statutory_rule_key`'s floor — M5-1), `pay_rate_percent`
 *    (100 for full pay, the per_rule split for infant-care/maternity),
 *    `carry_over_enabled` (default OFF at the column level — the Supreme
 *    Court "default carry-over ON for annual leave" position is a SEEDED
 *    DATA decision the service layer makes when it creates the `annual`
 *    type, not a schema-wide default; a company-defined type with no
 *    statutory carry-over expectation should not silently inherit "on"),
 *    `allows_half_day`/`allows_hourly` (M5-3), `cert_trigger_days` +
 *    `cert_trigger_rule_key` (the sick-leave medical-certificate trigger,
 *    itself floor-validated against `config.statutory_rule` the same way
 *    `entitlement_days` is — "the floor is that it may not be demanded for
 *    fewer than 3" is enforced by validating this COLUMN against a config
 *    floor, never by a literal `3` anywhere in this schema or the service
 *    layer), and `citation` (the legal citation shown alongside a shipped
 *    statutory default, per M5-1's "seeded from config with their
 *    citations" — null for company-only types, which have none).
 *
 *  - `leave_request` gains `half_day_period`, `hours` (0.5-day and hourly
 *    requests), `cert_required` (computed at submission time from
 *    `cert_trigger_days`, stored so the approval queue and ESS view don't
 *    each have to re-derive it), and `created_at` (ordering for the
 *    approval queue and balance ledger correlation).
 *
 *  - `leave_employee_ref` gains `start_date`/`terminated_at` — the read
 *    model populated from `employee.created`/`employee.updated`/
 *    `employee.terminated` needs the hire date for pro-ration and the
 *    termination timestamp to trigger `leave.balance_payout`; both are
 *    absent from the parent migration's minimal `{employee_id, status,
 *    updated_at}` shape because Phase 1-3 had no accrual engine to feed.
 *
 *  - `approval_step` gains `decided_by` — DISTINCT from `approver_id`.
 *    `approver_id` is the level's ASSIGNED approver (who `leave_request`
 *    submission designates, e.g. the employee's manager); `decided_by` is
 *    who actually clicked decide, which differs from `approver_id` exactly
 *    once: an active `approver_delegation` row lets a delegate decide in
 *    the assigned approver's place ("delegation approves when level-1
 *    approver on leave themselves" — M5-LEAVE.md §4 test hook). Recording
 *    both, rather than overwriting `approver_id`, keeps "who was supposed to
 *    decide this" auditable even when a delegate actually did.
 *
 *  - `balance_ledger` (new table) — the immutable per-employee/type/year
 *    append-only audit `BalanceLedger` in M5-LEAVE.md's class diagram calls
 *    for: every grant, taken, cancellation-reversal, carry-over and payout
 *    is one row here, never mutated or deleted. `leave_balance.entitled/
 *    taken/carried_over` is the current-state cache; this table is the
 *    "how did it get there" trail the M5-LEAVE.md test hooks require
 *    ("ledger sums always equal balance").
 *
 *  - `approval_level` (new table) — "multi-level approval chains by leave
 *    type and duration" (M5-3): one row per (leave_type, level), carrying
 *    the role that decides at that level and the `min_days` threshold above
 *    which the level applies (a short 1-day request may only need level 1;
 *    a 10-day request needs level 2 as well). `UNIQUE(leave_type_id, level)`
 *    is the natural key — two rows claiming the same level for the same
 *    type would make "who decides this level" ambiguous.
 *
 *  - `approver_delegation` (new table) — "delegation for absent approvers"
 *    (M5-3). A date-ranged grant: while `starts_on <= today <= ends_on`,
 *    `delegate_id` may decide any step assigned to `approver_id`.
 *    `ends_on >= starts_on` is enforced by CHECK so an inverted range can
 *    never be stored to mean "always" or "never" by accident.
 *
 * Every new numeric column here (`entitlement_days`, `pay_rate_percent`,
 * `cert_trigger_days`, `min_days`, `delta`) is `numeric`, never `real`/
 * `double precision` — same reasoning as the parent migration's four
 * columns: a leave balance becomes a cash payout on termination, so a float
 * rounding error anywhere near it is a payroll error.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — matching the parent migration's and every other service's
 * precedent); a later integration task re-proves this against real
 * Postgres.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.addColumns(
    { schema: 'leave', name: 'leave_type' },
    {
      // The value HR may raise freely but never lower below the config
      // floor bound to `statutory_rule_key` (M5-1). Nullable: a
      // per-certificate type like sterilization has no fixed entitlement.
      entitlement_days: { type: 'numeric' },
      unit: { type: 'text', notNull: true, default: 'days' },
      // 100 = full pay, the neutral/no-reduction default every pay_mode
      // other than 'per_rule' effectively means; NOT a statutory figure
      // copied from any specific leave type (infant-care's 50% split is a
      // config-resolved override the service applies at creation time, per
      // `leave-types.service.ts`, never a literal here).
      pay_rate_percent: { type: 'numeric', notNull: true, default: 100 },
      // Column-level default OFF on purpose — see file header: the
      // Supreme-Court-position "default ON for annual leave" is a seeded-
      // data decision the service makes for the `annual` type specifically,
      // not a schema-wide default every company-defined type should inherit.
      carry_over_enabled: { type: 'boolean', notNull: true, default: false },
      allows_half_day: { type: 'boolean', notNull: true, default: true },
      allows_hourly: { type: 'boolean', notNull: true, default: false },
      // Sick-leave medical-certificate trigger day count. NULL for every
      // non-sick type. Floor-validated against `cert_trigger_rule_key`'s
      // config floor the same way `entitlement_days` is validated against
      // `statutory_rule_key` — see `leave-types.service.ts`.
      cert_trigger_days: { type: 'numeric' },
      cert_trigger_rule_key: { type: 'text' },
      // The legal citation shown alongside a shipped statutory default
      // (M5-1: "seeded from config with their citations"). NULL for
      // company-only types, which have no citation to show.
      citation: { type: 'text' },
      active: { type: 'boolean', notNull: true, default: true },
    },
  )

  pgm.addColumns(
    { schema: 'leave', name: 'leave_request' },
    {
      half_day_period: { type: 'text' },
      hours: { type: 'numeric' },
      cert_required: { type: 'boolean', notNull: true, default: false },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint({ schema: 'leave', name: 'leave_request' }, 'leave_request_half_day_period_check', {
    check: "half_day_period IS NULL OR half_day_period IN ('AM', 'PM')",
  })

  pgm.addColumns(
    { schema: 'leave', name: 'leave_employee_ref' },
    {
      start_date: { type: 'date' },
      terminated_at: { type: 'timestamptz' },
    },
  )

  // Distinct from `approver_id` (the ASSIGNED approver for this level) —
  // see file header for why delegation needs both.
  pgm.addColumns(
    { schema: 'leave', name: 'approval_step' },
    {
      decided_by: { type: 'uuid' },
    },
  )

  pgm.createTable(
    { schema: 'leave', name: 'balance_ledger' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: { type: 'uuid', notNull: true },
      leave_type_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'leave', name: 'leave_type' },
        referencesConstraintName: 'balance_ledger_leave_type_id_fkey',
      },
      year: { type: 'integer', notNull: true },
      // Signed: a grant is positive, `leave_taken` negative, a
      // cancellation-reversal positive again, a payout negative (the
      // balance it consumes) — see file header, "how did it get there".
      delta: { type: 'numeric', notNull: true },
      reason: { type: 'text', notNull: true },
      // Correlates a ledger row back to the leave_request/employee_ref
      // event that produced it (nullable: a manual HR adjustment has none).
      ref_id: { type: 'uuid' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.createIndex({ schema: 'leave', name: 'balance_ledger' }, ['employee_id', 'leave_type_id', 'year'])

  pgm.createTable(
    { schema: 'leave', name: 'approval_level' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      leave_type_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'leave', name: 'leave_type' },
        referencesConstraintName: 'approval_level_leave_type_id_fkey',
      },
      level: { type: 'integer', notNull: true },
      approver_role: { type: 'text', notNull: true },
      min_days: { type: 'numeric', notNull: true, default: 0 },
    },
  )
  pgm.addConstraint({ schema: 'leave', name: 'approval_level' }, 'approval_level_type_level_key', {
    unique: ['leave_type_id', 'level'],
  })

  pgm.createTable(
    { schema: 'leave', name: 'approver_delegation' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      approver_id: { type: 'uuid', notNull: true },
      delegate_id: { type: 'uuid', notNull: true },
      starts_on: { type: 'date', notNull: true },
      ends_on: { type: 'date', notNull: true },
    },
  )
  pgm.addConstraint({ schema: 'leave', name: 'approver_delegation' }, 'approver_delegation_range_check', {
    check: 'ends_on >= starts_on',
  })
  pgm.createIndex({ schema: 'leave', name: 'approver_delegation' }, ['approver_id'])
}

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'leave', name: 'approver_delegation' })
  pgm.dropTable({ schema: 'leave', name: 'approval_level' })
  pgm.dropTable({ schema: 'leave', name: 'balance_ledger' })

  pgm.dropColumns({ schema: 'leave', name: 'approval_step' }, ['decided_by'])
  pgm.dropColumns({ schema: 'leave', name: 'leave_employee_ref' }, ['start_date', 'terminated_at'])
  pgm.dropColumns({ schema: 'leave', name: 'leave_request' }, [
    'half_day_period',
    'hours',
    'cert_required',
    'created_at',
  ])
  pgm.dropColumns({ schema: 'leave', name: 'leave_type' }, [
    'entitlement_days',
    'unit',
    'pay_rate_percent',
    'carry_over_enabled',
    'allows_half_day',
    'allows_hourly',
    'cert_trigger_days',
    'cert_trigger_rule_key',
    'citation',
    'active',
  ])
}
