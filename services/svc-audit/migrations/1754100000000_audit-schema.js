'use strict'

/**
 * `audit` schema — Task 9 brief, exactly:
 *
 *   audit.entry(id bigserial pk, occurred_at timestamptz, actor_id uuid, actor_role text,
 *               action text, entity text, entity_id text, purpose text null,
 *               before_hash text null, after_hash text null,
 *               prev_entry_hash text, entry_hash text)
 *
 * Plus `processed_events(event_id PK)` — this service CONSUMES `audit.*`
 * events emitted into every other service's own outbox (kernel
 * `AuditEmitter`/`OutboxRelay`); it does not publish anything of its own, so
 * unlike every other service's schema (global-constraints: "every schema has
 * `outbox(...)` and `processed_events(...)`"), there is deliberately **no
 * `audit.outbox` table here** — an append-only log that itself queued
 * outbound events would be the one schema in the system with a write path
 * this migration doesn't lock down.
 *
 * `before_hash`/`after_hash` are text, never the values themselves (roadmap
 * "Audit entry" §, Security doc §5, Task 5 review 2026-08-02): this table
 * has no `before`/`after` jsonb column at all, so there is no column an S3
 * value could land in even by accident — see `chain.ts`/`consumer.ts` for
 * where the hashing happens, before a row ever reaches this table.
 *
 * Not executed against a real Postgres in this environment — there is none
 * here (Task 9 brief CONSTRAINTS) — a later integration task runs this for
 * real, the same deferral `services/svc-config`'s migration documents.
 */

exports.shorthands = undefined

/**
 * `entry_id PK` sequencing lives entirely in `id bigserial` — Postgres
 * assigns it at INSERT time from a sequence, independent of transaction
 * outcome, which is exactly the ordering `chain.ts#verifyChain` walks
 * (`ORDER BY id ASC`). The chain's own tamper-evidence comes from
 * `prev_entry_hash`/`entry_hash`, not from `id` being gapless — a rolled-
 * back insert burning a sequence value is expected and harmless.
 *
 * The role name below is written as the literal `audit` in every `pgm.sql`
 * call rather than interpolated from a constant: `src/migration.test.ts`
 * asserts directly against this file's own source text (there is no
 * Postgres here to run the migration against and inspect real grants — see
 * CONSTRAINTS), so the grant/revoke statements must appear as plain,
 * greppable SQL, not `${...}` template placeholders a static text scan
 * would never resolve.
 */

exports.up = (pgm) => {
  pgm.createSchema('audit', { ifNotExists: true })

  pgm.createTable(
    { schema: 'audit', name: 'entry' },
    {
      id: { type: 'bigserial', primaryKey: true },
      occurred_at: { type: 'timestamptz', notNull: true },
      actor_id: { type: 'uuid', notNull: true },
      actor_role: { type: 'text', notNull: true },
      action: { type: 'text', notNull: true },
      entity: { type: 'text', notNull: true },
      entity_id: { type: 'text', notNull: true },
      purpose: { type: 'text' },
      before_hash: { type: 'text' },
      after_hash: { type: 'text' },
      prev_entry_hash: { type: 'text', notNull: true },
      entry_hash: { type: 'text', notNull: true },
    },
  )
  // Every reporting/verify access pattern this service exposes: "entries for
  // this entity", "entries in this time range", and "every entry, in chain
  // order" (`/verify`, covered by the primary key's own btree — no extra
  // index needed for an `ORDER BY id`).
  pgm.createIndex({ schema: 'audit', name: 'entry' }, ['entity', 'entity_id'])
  pgm.createIndex({ schema: 'audit', name: 'entry' }, ['occurred_at'])

  // `event_id PK` — without it dedupe silently degrades to a no-op (mirrors
  // `services/svc-config`'s migration note, Task 7 brief §1).
  pgm.createTable(
    { schema: 'audit', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )

  // --- The grants are the point (Task 9 brief) ---
  //
  // This migration itself must run as a privileged/owner role (it issues
  // CREATE SCHEMA/CREATE TABLE), never as `audit` — `audit` is created here
  // specifically because it must NOT be able to do any of that. `NOLOGIN` by
  // default; a real deployment's bootstrap (`deploy/postgres/init`, outside
  // this service's directory) grants it a login password out of band —
  // secrets are never committed (roadmap "Standing constraints"), so no
  // password is set in this file.
  //
  // `REVOKE ALL` before the explicit `GRANT SELECT, INSERT` is not
  // redundant: it makes the absence of UPDATE/DELETE an explicit statement
  // in this file rather than an assumption resting on Postgres's
  // default-deny-until-granted behaviour, which is what
  // `src/migration.test.ts` scans this exact SQL text for. An append-only
  // audit log the application (or a role it holds) can rewrite is not
  // append-only — this is the belt; `entries.repository.ts` deliberately
  // exposing no `updateEntry`/`deleteEntry` method at all is the brace.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'audit') THEN
        CREATE ROLE audit NOLOGIN;
      END IF;
    END
    $$;
  `)
  pgm.sql('GRANT USAGE ON SCHEMA audit TO audit;')
  pgm.sql('REVOKE ALL ON audit.entry FROM audit;')
  pgm.sql('REVOKE ALL ON audit.processed_events FROM audit;')
  pgm.sql('GRANT SELECT, INSERT ON audit.entry TO audit;')
  pgm.sql('GRANT SELECT, INSERT ON audit.processed_events TO audit;')
  // Explicitly NOT granted, ever, to the audit role: UPDATE, DELETE,
  // TRUNCATE, or ownership of either table.
}

exports.down = (pgm) => {
  pgm.dropSchema('audit', { cascade: true, ifExists: true })
  pgm.sql('DROP ROLE IF EXISTS audit;')
}
