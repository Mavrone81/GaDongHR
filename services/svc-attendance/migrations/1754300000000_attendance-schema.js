'use strict'

/**
 * `attendance` schema — Task 14 brief, DATABASE-DESIGN.md §2.2, exactly:
 *
 *   attendance.enrollment(id uuid pk, employee_id uuid UNIQUE, method text,
 *     face_subject_ref text, status text, enrolled_at timestamptz,
 *     template_deleted_at timestamptz null)
 *   attendance.device(id uuid pk, kind text, site_code text,
 *     device_secret bytea, status text)
 *   attendance.punch_event(id uuid pk, idem_key text UNIQUE, employee_id uuid,
 *     device_id uuid fk -> device, punched_at timestamptz, direction text,
 *     method text, match_score numeric null, liveness_passed bool null,
 *     site_code text, geo jsonb null)
 *   attendance.attendance_employee_ref(employee_id uuid pk, status text,
 *     updated_at timestamptz) — a read model fed by `employee.*` events
 *     (DATABASE-DESIGN.md §1: "Employee identity across services ... no
 *     foreign keys across schemas"). Deliberately carries no `references`
 *     to `onboarding.employee` — that table lives in a schema this
 *     service's DB role cannot even see.
 *
 * Plus the two tables every schema carries: `outbox` and
 * `processed_events(event_id PK)` (roadmap "Database conventions").
 *
 * ---------------------------------------------------------------------
 * WHY THIS FILE IS THE SAFETY BOUNDARY FOR M4 (Task 14 brief, "why this
 * service matters"):
 *
 * GaDongHR never stores a face embedding — CompreFace's own Postgres
 * schema is the only place a template ever lives (DATABASE-DESIGN.md
 * §2.2's closing note). `enrollment.face_subject_ref` is that boundary:
 * it is an OPAQUE STRING ID CompreFace hands back, `text`, never the
 * template bytes themselves. There is deliberately no DB-level CHECK that
 * can enforce "this text value is an id and not an embedding" (a check
 * constraint validates a row's VALUE, not a column's shape) — the control
 * that actually holds the line is `face_subject_ref` being declared
 * `text`, never `bytea`, and `attendance-schema.test.ts`'s "the only
 * bytea column in this whole schema is device_secret" assertion, which
 * fails the build the moment anyone (or any future migration) adds a
 * second one. That test is the "brace" to this file's "belt" — see
 * `services/svc-authz/migrations/*.js`'s `role_permission_no_biometric_check`
 * for the same belt-and-brace shape applied to a different absolute rule.
 *
 * `device.device_secret` IS the schema's one legitimate `bytea` column —
 * S3-classified (Security doc §3), envelope-encrypted by `svc-crypto`
 * before every INSERT/UPDATE (kernel `CryptoClient`), never written in
 * the clear. A leaked device secret lets someone forge punches for an
 * entire site, which is why it is encrypted at rest at all, unlike
 * `punch_event`'s own columns (facts about who/when/where, not secrets).
 *
 * `punch_event.idem_key` (`device_id + seq`, UNIQUE) is the sole
 * mechanism by which a kiosk replaying its offline queue after a
 * connectivity outage does not create duplicate punches — see
 * `attendance-schema.test.ts` for a demonstration that the uniqueness
 * assertion fails the instant this constraint is removed.
 *
 * `template_deleted_at` is nullable evidence, not bookkeeping: it is how
 * consent withdrawal and termination deletions are provably honoured
 * within the PDPA SLA (PDPA-BIOMETRIC-COMPLIANCE.md §7: face template
 * deleted ≤7 days after termination/withdrawal). A row with `status =
 * 'deleted'` and a null `template_deleted_at` would be exactly the kind
 * of gap an auditor should be able to find with one query.
 *
 * Business logic — enrolment, matching, liveness scoring, punch ingestion
 * — is explicitly out of scope for this task (Task 14 brief: "Phase 3
 * owns those, gated on the CompreFace benchmark"). This migration exists
 * so the shape is right before any of that code is written, not to
 * implement it.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 14 brief CONSTRAINTS, matching Tasks 7/8/9's precedent); a
 * later integration task re-proves this against real Postgres.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('attendance', { ifNotExists: true })

  pgm.createTable(
    { schema: 'attendance', name: 'enrollment' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // UNIQUE, not just indexed: DATABASE-DESIGN.md §2.2 models one
      // enrolment per employee — a second concurrent enrolment attempt
      // must fail at the DB, not merely be discouraged by application code.
      employee_id: { type: 'uuid', notNull: true },
      method: { type: 'text', notNull: true },
      // Opaque CompreFace subject id ONLY — see the file-level comment.
      // Nullable because a `pin`/`qr`/`badge`-only enrolment never talks to
      // CompreFace and so never receives one; only a `method = 'face'` row
      // populates it.
      face_subject_ref: { type: 'text' },
      status: { type: 'text', notNull: true, default: 'active' },
      enrolled_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      // Nullable: null until consent withdrawal or termination triggers
      // deletion; once set, it is the timestamped proof that the PDPA §7
      // deletion SLA was met for this employee's template.
      template_deleted_at: { type: 'timestamptz' },
    },
    {
      constraints: {
        enrollment_employee_id_key: { unique: ['employee_id'] },
        enrollment_method_check: { check: "method IN ('face', 'pin', 'qr', 'badge')" },
        enrollment_status_check: { check: "status IN ('active', 'suspended', 'deleted')" },
      },
    },
  )

  pgm.sql(`COMMENT ON COLUMN attendance.enrollment.face_subject_ref IS
    'Opaque CompreFace subject id ONLY. This column must remain text and must NEVER become bytea or otherwise hold a face embedding -- GaDongHR never stores biometric templates (PDPA s.26; DATABASE-DESIGN.md section 2.2). The embedding itself lives only inside CompreFace''s own storage, referenced by this id.'`)

  pgm.createTable(
    { schema: 'attendance', name: 'device' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      kind: { type: 'text', notNull: true },
      site_code: { type: 'text', notNull: true },
      // The one legitimate bytea column in this schema — see the
      // file-level comment and `attendance-schema.test.ts`'s explicit
      // enumeration test.
      device_secret: { type: 'bytea', notNull: true },
      status: { type: 'text', notNull: true, default: 'active' },
    },
    {
      constraints: {
        device_kind_check: { check: "kind IN ('kiosk', 'mobile')" },
      },
    },
  )
  pgm.createIndex({ schema: 'attendance', name: 'device' }, ['site_code'])

  pgm.sql(`COMMENT ON COLUMN attendance.device.device_secret IS
    'S3-classified secret. Always envelope-encrypted by svc-crypto before INSERT/UPDATE -- never written in the clear (Security doc section 3). A leaked device secret lets someone forge punches for a whole site.'`)

  pgm.createTable(
    { schema: 'attendance', name: 'punch_event' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // UNIQUE — see file-level comment: this is the sole mechanism
      // preventing a reconnecting kiosk from double-writing its offline
      // queue.
      idem_key: { type: 'text', notNull: true },
      employee_id: { type: 'uuid', notNull: true },
      device_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'attendance', name: 'device' },
        referencesConstraintName: 'punch_event_device_id_fkey',
      },
      punched_at: { type: 'timestamptz', notNull: true },
      direction: { type: 'text', notNull: true },
      method: { type: 'text', notNull: true },
      // Nullable: a PIN/QR/badge punch never produces a face-match score.
      match_score: { type: 'numeric' },
      // Nullable: liveness detection only ever runs for a `method = 'face'`
      // punch; every other method has no liveness result to record, and a
      // non-null false/true here would misleadingly imply a check ran.
      liveness_passed: { type: 'boolean' },
      site_code: { type: 'text', notNull: true },
      // Nullable — PWA geofence capture is P1 (DATABASE-DESIGN.md §2.2);
      // most punches (kiosk) never populate it.
      geo: { type: 'jsonb' },
    },
    {
      constraints: {
        punch_event_idem_key_key: { unique: ['idem_key'] },
        punch_event_direction_check: { check: "direction IN ('in', 'out')" },
        punch_event_method_check: { check: "method IN ('face', 'pin', 'qr', 'badge', 'manual')" },
      },
    },
  )
  pgm.createIndex({ schema: 'attendance', name: 'punch_event' }, ['employee_id', 'punched_at'])
  pgm.createIndex({ schema: 'attendance', name: 'punch_event' }, ['device_id'])

  // Read model fed by `employee.*` events (DATABASE-DESIGN.md §1) — no
  // `references` to `onboarding.employee`: cross-schema foreign keys are
  // disallowed by convention (each service's DB role can see only its own
  // schema; a cross-schema FK would not even be enforceable by every
  // role). Populated by a future `idempotent()`-driven consumer, not by
  // this migration.
  pgm.createTable(
    { schema: 'attendance', name: 'attendance_employee_ref' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      status: { type: 'text', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )

  pgm.createTable(
    { schema: 'attendance', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'attendance', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (roadmap "Database conventions").
  pgm.createTable(
    { schema: 'attendance', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  pgm.dropSchema('attendance', { cascade: true, ifExists: true })
}
