'use strict'

/**
 * Fixes Task 16c's defect for `authz`: node-pg-migrate's
 * `createTable(name, columns, options)` only recognises `options.constraints`
 * as an object keyed by CONSTRAINT KIND (`unique`/`primaryKey`/`check`/
 * `foreignKeys`/`exclude`/`deferrable`/`comment`) — see node-pg-migrate
 * 7.9.1's own `dist/operations/tables/shared.js#parseConstraints`, which
 * destructures exactly those six/seven names straight off the `constraints`
 * object passed to it. `1754100000000_authz-schema.js` instead nested a
 * user-chosen constraint NAME one level deeper —
 * `{ constraints: { role_code_key: { unique: ['code'] } } }` and
 * `{ constraints: { role_permission_pkey: {...}, role_permission_no_biometric_check: {...} } }`
 * — so `parseConstraints` finds no recognised kind in either options object
 * and silently emits nothing. No error, no warning; `CREATE TABLE` still
 * succeeds, just without the constraint.
 *
 * Confirmed against `pg_constraint` on the live droplet: `authz.role` carries
 * only its primary key (no unique constraint on `code`), and
 * `authz.role_permission` carries only its two foreign keys (no composite
 * primary key, no CHECK). This is what crash-loops `svc-authz` in production:
 * `authz.repository.ts`'s seeder does `ON CONFLICT (code) DO UPDATE`, which
 * requires a unique constraint or index on exactly the conflict target
 * columns — with none present, Postgres raises "there is no unique or
 * exclusion constraint matching the ON CONFLICT specification" on every
 * seed/upsert attempt.
 *
 * `1754100000000_authz-schema.js` itself is deliberately NOT edited by this
 * fix. It already ran on `gadonghr-prod` (Task 16) — node-pg-migrate records
 * applied migrations by name in `pgmigrations` and never re-runs one, so a
 * `pgm.createTable`-level edit there would change nothing for that database.
 * It also must not be "corrected" to the valid inline shape, because a fresh
 * environment (a new `pgmigrations` ledger with no rows in it) replays every
 * migration in order — if the parent migration created these constraints
 * AND this file also tried to add them, `pgm.addConstraint` would fail with
 * "constraint already exists". Leaving the parent migration exactly as it
 * is (a harmless no-op for constraints, same as it always was) and doing the
 * actual creation here, once, keeps prod and every fresh environment
 * consistent: the parent migration never created these constraints in
 * either case, and this migration is what creates them in both.
 *
 * De-duplication before each ADD CONSTRAINT: because these constraints have
 * never existed, it is possible (not just theoretical — this is exactly the
 * kind of gap a missing UNIQUE/PK invites) that the live table already holds
 * rows that would violate them. Adding the constraint against dirty data
 * fails outright and leaves the fix half-applied, which is worse than
 * running it once, deliberately, here. `role`/`role_permission` are pure
 * reference/assignment rows with no independent history a "which duplicate
 * wins" choice could corrupt, so keeping an arbitrary single survivor per
 * conflicting key is safe.
 *
 * What each constraint protects:
 *  - `role_code_key` (UNIQUE `role.code`) — without it, duplicate roles are
 *    possible, and the seeder's `ON CONFLICT (code)` has nothing to match
 *    against, which is the live crash-loop above.
 *  - `role_permission_pkey` (composite PRIMARY KEY on
 *    `role_id, permission_code`) — without it, a role can hold the same
 *    permission twice; there was no natural-key enforcement on this table at
 *    all.
 *  - `role_permission_no_biometric_check` (CHECK `permission_code <>
 *    'biometric.template.read'`) — a SECURITY CONTROL, not a data-quality
 *    one: Security doc §4.2's absolute rule is that no role, including
 *    System Admin, may carry `biometric.template.read`. `seed/roles.ts`'s
 *    `assertNoBiometricGrant` is the application-level brace for the same
 *    rule; it does not make this belt redundant — until this migration, the
 *    rule was enforced nowhere in the database at all, only in application
 *    code that a future bug could bypass.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  // Defensive de-dup — see file header. No-op if the live table is already
  // clean (the common case; included because this migration must be safe to
  // run against the live, currently-unconstrained database, not just a
  // hypothetically clean one).
  pgm.sql(`
    DELETE FROM authz.role a USING authz.role b
    WHERE a.code = b.code AND a.id > b.id;
  `)
  pgm.sql(`
    DELETE FROM authz.role_permission a USING authz.role_permission b
    WHERE a.role_id = b.role_id
      AND a.permission_code = b.permission_code
      AND a.ctid > b.ctid;
  `)

  pgm.addConstraint({ schema: 'authz', name: 'role' }, 'role_code_key', {
    unique: ['code'],
  })
  pgm.addConstraint(
    { schema: 'authz', name: 'role_permission' },
    'role_permission_pkey',
    { primaryKey: ['role_id', 'permission_code'] },
  )
  pgm.addConstraint(
    { schema: 'authz', name: 'role_permission' },
    'role_permission_no_biometric_check',
    { check: "permission_code <> 'biometric.template.read'" },
  )
}

exports.down = (pgm) => {
  pgm.dropConstraint(
    { schema: 'authz', name: 'role_permission' },
    'role_permission_no_biometric_check',
  )
  pgm.dropConstraint({ schema: 'authz', name: 'role_permission' }, 'role_permission_pkey')
  pgm.dropConstraint({ schema: 'authz', name: 'role' }, 'role_code_key')
}
