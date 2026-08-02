'use strict'

/**
 * `authz` schema — Task 8 brief §1, exactly:
 *
 *   authz.role(id uuid pk, code text unique, name_i18n jsonb, is_system bool)
 *   authz.permission(code text pk, description text)
 *   authz.role_permission(role_id uuid, permission_code text, pk(role_id, permission_code))
 *   authz.user_role(id uuid pk, user_id uuid, role_id uuid, org_scope_unit_id uuid null,
 *                   granted_by uuid, granted_at timestamptz)
 *   authz.org_unit(id uuid pk, parent_id uuid null, name_i18n jsonb, cost_center text)
 *
 * Plus the two tables every schema carries: `outbox` and
 * `processed_events(event_id PK)` (roadmap "Database conventions").
 *
 * `role_permission_no_biometric_check` is a DB-level "belt": Security doc
 * §4.2's absolute rule ("No role — including System Admin — carries
 * biometric.template.read") is enforced twice, independently — here, and
 * again as the "brace" in `seed/roles.ts`'s `assertNoBiometricGrant`. See
 * `authz.repository.test.ts` and `seed/roles.test.ts` for both failing
 * independently when the other is removed (Task 8 brief, carried-forward
 * binding: "a guard that has not been seen to fail is not a guard").
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 8 brief, carried-forward binding); a later task re-proves
 * this against real Postgres, matching Tasks 4 and 7.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('authz', { ifNotExists: true })

  pgm.createTable(
    { schema: 'authz', name: 'role' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      code: { type: 'text', notNull: true },
      name_i18n: { type: 'jsonb', notNull: true },
      is_system: { type: 'boolean', notNull: true, default: false },
    },
    { constraints: { role_code_key: { unique: ['code'] } } },
  )

  pgm.createTable(
    { schema: 'authz', name: 'permission' },
    {
      code: { type: 'text', primaryKey: true },
      description: { type: 'text', notNull: true },
    },
  )

  pgm.createTable(
    { schema: 'authz', name: 'role_permission' },
    {
      role_id: { type: 'uuid', notNull: true, references: { schema: 'authz', name: 'role' }, referencesConstraintName: 'role_permission_role_id_fkey', onDelete: 'CASCADE' },
      permission_code: { type: 'text', notNull: true, references: { schema: 'authz', name: 'permission' }, referencesConstraintName: 'role_permission_permission_code_fkey' },
    },
    {
      constraints: {
        role_permission_pkey: { primaryKey: ['role_id', 'permission_code'] },
        // Belt — see file-level comment.
        role_permission_no_biometric_check: {
          check: "permission_code <> 'biometric.template.read'",
        },
      },
    },
  )

  pgm.createTable(
    { schema: 'authz', name: 'org_unit' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      parent_id: { type: 'uuid', references: { schema: 'authz', name: 'org_unit' }, referencesConstraintName: 'org_unit_parent_id_fkey' },
      name_i18n: { type: 'jsonb', notNull: true },
      cost_center: { type: 'text' },
    },
  )

  pgm.createTable(
    { schema: 'authz', name: 'user_role' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      user_id: { type: 'uuid', notNull: true },
      role_id: { type: 'uuid', notNull: true, references: { schema: 'authz', name: 'role' }, referencesConstraintName: 'user_role_role_id_fkey' },
      org_scope_unit_id: { type: 'uuid', references: { schema: 'authz', name: 'org_unit' }, referencesConstraintName: 'user_role_org_scope_unit_id_fkey' },
      granted_by: { type: 'uuid', notNull: true },
      granted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.createIndex({ schema: 'authz', name: 'user_role' }, ['user_id'])

  pgm.createTable(
    { schema: 'authz', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'authz', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (roadmap "Database conventions").
  pgm.createTable(
    { schema: 'authz', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  pgm.dropSchema('authz', { cascade: true, ifExists: true })
}
