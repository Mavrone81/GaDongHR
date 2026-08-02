'use strict'

/**
 * `config` schema — DATABASE-DESIGN §2.6, exactly:
 *
 *   config.statutory_rule(id uuid pk, rule_key text, value jsonb, unit text,
 *     statutory_floor jsonb, statutory_ceiling jsonb, citation text,
 *     effective_from date, effective_to date,
 *     governance_class text, status text,
 *     proposed_by uuid, approved_by uuid, reason text,
 *     created_at timestamptz)
 *   UNIQUE (rule_key, effective_from)
 *
 * Plus the two tables every schema carries: `outbox` and
 * `processed_events(event_id PK)` (global-constraints; roadmap "Database
 * conventions"). `gen_random_uuid()` is built into Postgres core since 13 —
 * no `pgcrypto` extension needed on Postgres 16.
 *
 * Segregation of duties (roadmap "Permission catalog"): `proposed_by ≠
 * approved_by`, enforced here as a DB CHECK (belt) and separately by
 * `rules.service.ts` (braces — see task-7-report.md for both layers
 * demonstrated failing independently when removed). `IS NULL` on either
 * side is allowed: a freshly proposed row has no `approved_by` yet, and a
 * pack-imported row may carry neither (see `packs.service.ts`).
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — see Task 7 brief); Task 13b runs this for real.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('config', { ifNotExists: true })

  pgm.createTable(
    { schema: 'config', name: 'statutory_rule' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      rule_key: { type: 'text', notNull: true },
      value: { type: 'jsonb', notNull: true },
      unit: { type: 'text', notNull: true },
      statutory_floor: { type: 'jsonb' },
      statutory_ceiling: { type: 'jsonb' },
      citation: { type: 'text', notNull: true },
      effective_from: { type: 'date', notNull: true },
      effective_to: { type: 'date' },
      governance_class: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'draft' },
      proposed_by: { type: 'uuid' },
      approved_by: { type: 'uuid' },
      reason: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        statutory_rule_rule_key_effective_from_key: { unique: ['rule_key', 'effective_from'] },
        statutory_rule_governance_class_check: {
          check: "governance_class IN ('STATUTORY_FLOOR', 'STATUTORY_FIXED', 'COMPANY_POLICY')",
        },
        statutory_rule_status_check: {
          check: "status IN ('draft', 'pending_approval', 'active', 'superseded')",
        },
        // Belt: survives a future service-layer bug (Task 7 brief §3). See
        // `rules.service.ts` for the braces — the equivalent application check.
        statutory_rule_sod_check: {
          check: 'proposed_by IS NULL OR approved_by IS NULL OR proposed_by <> approved_by',
        },
      },
    },
  )
  pgm.createIndex({ schema: 'config', name: 'statutory_rule' }, ['rule_key', 'status'])

  pgm.createTable(
    { schema: 'config', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'config', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (Task 7 brief §1).
  pgm.createTable(
    { schema: 'config', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  pgm.dropSchema('config', { cascade: true, ifExists: true })
}
