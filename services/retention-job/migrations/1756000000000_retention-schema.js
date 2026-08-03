'use strict'

/**
 * `retention` schema — Task 14 brief, exactly:
 *
 *   retention.policy(id uuid pk, data_class text, table_ref text,
 *     retention_period interval, legal_driver text, effective_from date,
 *     effective_to date null)
 *   retention.candidate(id uuid pk, policy_id uuid fk, entity_type text,
 *     entity_id text, identified_at timestamptz, eligible_at date,
 *     status text, reviewed_by uuid null, reviewed_at timestamptz null,
 *     erased_at timestamptz null, legal_hold_reason text null)
 *   retention.run(id uuid pk, started_at timestamptz, finished_at
 *     timestamptz null, candidates_found int, candidates_erased int,
 *     status text)
 *
 * Plus `processed_events(event_id PK)` (roadmap "Database conventions").
 * No `outbox` table: the event catalog (roadmap, "Event catalog") has no
 * `retention.*` producer entry — this service doesn't publish, only acts —
 * so an outbox here would be dead weight, matching `svc-audit`'s precedent
 * (a consumer-only schema that also carries no outbox). If Phase 5 adds a
 * `retention.candidate_erased` event or similar, the outbox table lands in
 * that migration, alongside the code that actually writes to it.
 *
 * `gen_random_uuid()` is built into Postgres core since 13 — no `pgcrypto`
 * extension needed on Postgres 16 (matches every sibling migration).
 *
 * Not executed against a real Postgres in this environment (Task 14 brief
 * CONSTRAINTS — no Postgres here); asserted instead against this file's own
 * generated shape in `src/retention-schema.test.ts`, the technique
 * `services/svc-attendance` and `services/svc-audit` established.
 *
 * --- Three rules this schema makes structurally true (Task 14 brief) ---
 *
 * 1. `candidate.legal_hold_reason` exists and is nullable free text. A
 *    record under an active labour dispute or tax audit must never be
 *    deleted regardless of age, and the schema can always say *why* a
 *    candidate was skipped — a silent skip is indistinguishable from a bug.
 *
 * 2. `candidate.status` carries a CHECK covering all six states
 *    (`identified|awaiting_review|approved|erased|blocked_legal_hold|
 *    blocked_conflict`), *and* a second CHECK
 *    (`candidate_erased_requires_review_check`) that a row can only be
 *    `erased` if `reviewed_by`, `reviewed_at` and `erased_at` are all set.
 *    That second check is what makes "never move to erased without passing
 *    through review" a DB-level guarantee rather than a convention Phase
 *    5's application code merely happens to follow — the same belt-and-brace
 *    pattern `config.statutory_rule`'s SoD check and `authz.role_permission`'s
 *    no-biometric check use elsewhere in this codebase.
 *
 * 3. `erased_at` is a column on the surviving `candidate` row, never a
 *    signal encoded by the row's absence. Crypto-erasure and physical
 *    delete happen to the *subject's* data in its owning schema — never to
 *    this row. There is no FK from `candidate` to the subject at all (by
 *    design: `entity_type` + `entity_id` are plain text, per the roadmap's
 *    "no foreign keys across schemas, no cross-schema queries" convention),
 *    so there is structurally nothing that could cascade a candidate away
 *    when its subject is erased. The one FK this schema does own —
 *    `candidate.policy_id → policy.id` — carries no `onDelete`, so Postgres
 *    defaults to blocking a policy delete that still has candidates
 *    attached, rather than silently taking the candidates with it.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('retention', { ifNotExists: true })

  pgm.createTable(
    { schema: 'retention', name: 'policy' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      data_class: { type: 'text', notNull: true },
      table_ref: { type: 'text', notNull: true },
      // `interval`, not an integer day-count column: "2 years" and "5
      // years" are expressible directly (Task 14 brief TESTS) rather than
      // as a magic number of days that a reader has to reverse-engineer.
      retention_period: { type: 'interval', notNull: true },
      legal_driver: { type: 'text', notNull: true },
      effective_from: { type: 'date', notNull: true },
      effective_to: { type: 'date' },
    },
  )
  // Task 16c fix: node-pg-migrate's `createTable` `constraints` option is
  // keyed by CONSTRAINT KIND, not by a chosen name — the previous
  // `{ constraints: { policy_data_class_effective_from_key: { unique: [...] } } }`
  // nested the name one level too deep, so node-pg-migrate's
  // `parseConstraints` found no recognised kind and silently created
  // nothing. This service has never been deployed, so the fix is an
  // in-place edit; `pgm.addConstraint` is used so the name matches this
  // file's own prior comments/tests verbatim.
  //
  // Effective-dated like every other rule in this system (Task 14 brief) —
  // mirrors `config.statutory_rule`'s UNIQUE(rule_key, effective_from): a
  // data class can be re-legislated with a new effective_from row, never
  // silently overwritten in place.
  pgm.addConstraint(
    { schema: 'retention', name: 'policy' },
    'policy_data_class_effective_from_key',
    { unique: ['data_class', 'effective_from'] },
  )
  pgm.createIndex({ schema: 'retention', name: 'policy' }, ['data_class'])

  pgm.createTable(
    { schema: 'retention', name: 'candidate' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // No `onDelete` — see file header, rule 3: a policy with candidates
      // attached cannot be deleted out from under them.
      policy_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'retention', name: 'policy' },
        referencesConstraintName: 'candidate_policy_id_fkey',
      },
      // Deliberately plain text, not a cross-schema FK — "No foreign keys
      // across schemas. No cross-schema queries" (roadmap, "Database
      // conventions"). This is also what makes rule 3 (no cascade can ever
      // delete this row) structurally true rather than merely convention.
      entity_type: { type: 'text', notNull: true },
      entity_id: { type: 'text', notNull: true },
      identified_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      eligible_at: { type: 'date', notNull: true },
      status: { type: 'text', notNull: true, default: 'identified' },
      reviewed_by: { type: 'uuid' },
      reviewed_at: { type: 'timestamptz' },
      // Proof deletion happened, and when — a compliance artefact in its
      // own right, kept on this surviving row rather than inferred from
      // the row (or the subject) being gone (Task 14 brief, rule 3).
      erased_at: { type: 'timestamptz' },
      // Why a candidate was skipped, never silent (Task 14 brief, rule 1).
      legal_hold_reason: { type: 'text' },
    },
  )
  pgm.addConstraint({ schema: 'retention', name: 'candidate' }, 'candidate_status_check', {
    check:
      "status IN ('identified', 'awaiting_review', 'approved', 'erased', 'blocked_legal_hold', 'blocked_conflict')",
  })
  // The DPO-approval gate as a DB-level guarantee, not just an application
  // convention (Task 14 brief, rule 2 — "must never move to erased without
  // passing through review").
  pgm.addConstraint(
    { schema: 'retention', name: 'candidate' },
    'candidate_erased_requires_review_check',
    {
      check:
        "status <> 'erased' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND erased_at IS NOT NULL)",
    },
  )
  pgm.createIndex({ schema: 'retention', name: 'candidate' }, ['policy_id'])
  pgm.createIndex({ schema: 'retention', name: 'candidate' }, ['status'])
  pgm.createIndex({ schema: 'retention', name: 'candidate' }, ['eligible_at'])

  pgm.createTable(
    { schema: 'retention', name: 'run' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      finished_at: { type: 'timestamptz' },
      candidates_found: { type: 'integer', notNull: true, default: 0 },
      candidates_erased: { type: 'integer', notNull: true, default: 0 },
      status: { type: 'text', notNull: true, default: 'running' },
    },
  )
  pgm.addConstraint({ schema: 'retention', name: 'run' }, 'run_status_check', {
    check: "status IN ('running', 'completed', 'failed')",
  })
  pgm.createIndex({ schema: 'retention', name: 'run' }, ['started_at'])

  // `event_id PK` — without it dedupe silently degrades to a no-op (roadmap "Database conventions").
  pgm.createTable(
    { schema: 'retention', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )

  // Seed: PDPA-BIOMETRIC-COMPLIANCE.md §7's retention schedule, as active
  // configuration (that document's own §9.7 item). Every row here is a rule
  // Phase 5's scan must eventually apply; none of the scan/DPO-queue/
  // crypto-erasure/conflict-resolution logic itself lands here (Task 14
  // brief — Phase 5 owns those). `effective_from` follows this codebase's
  // existing precedent (`services/svc-config/seed/TH-STATUTORY-v1.json`):
  // the date the underlying statute took effect where a compliance doc in
  // this repo already pins one, or this policy's own configuration date
  // where it doesn't (Revenue Code / Accounting Act / general civil
  // limitation period commencement dates are not asserted here — Thai
  // counsel review is the standing precondition for all of §7, per that
  // doc's own disclaimer).
  pgm.sql(`
    INSERT INTO retention.policy
      (data_class, table_ref, retention_period, legal_driver, effective_from)
    VALUES
      ('face_template', 'attendance.enrollment', interval '7 days', 'PDPA minimisation (facial template, employment duration only)', '2022-06-01'),
      ('enrolment_raw_image', 'attendance.enrollment', interval '7 days', 'PDPA minimisation (raw enrolment image)', '2022-06-01'),
      ('punch_attendance_record', 'attendance.punch_event', interval '2 years', 'LPA s.114-115 (working-time/wage records, >= 2 years after termination)', '1998-08-19'),
      ('employee_register_wage_ot_docs', 'timesheet.day_record', interval '2 years', 'LPA s.112, s.115 (employee register & wage/OT payment docs, after termination)', '1998-08-19'),
      ('payroll_tax_record', 'payroll.statutory_export', interval '5 years', 'Revenue Code (PND, 50 bis)', '2026-08-01'),
      ('accounting_payroll_journal', 'payroll.payslip', interval '5 years', 'Accounting Act (accounting-relevant payroll journals)', '2026-08-01'),
      ('sick_leave_medical_certificate', 'leave.leave_request', interval '2 years', 'LPA records + PDPA minimisation (diagnosis minimised, after leave year)', '1998-08-19'),
      ('consent_record', 'onboarding.consent_record', interval '10 years', 'Evidentiary (duration of processing + default 10-year limitation period)', '2026-08-01'),
      ('candidate_data_never_hired', 'onboarding.employee', interval '6 months', 'PDPA minimisation (candidate not hired)', '2022-06-01')
  `)
}

exports.down = (pgm) => {
  pgm.dropSchema('retention', { cascade: true, ifExists: true })
}
