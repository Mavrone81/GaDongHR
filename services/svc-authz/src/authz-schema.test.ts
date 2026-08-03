import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Task 16c: `1754100000000_authz-schema.js` declared `role`'s and
 * `role_permission`'s table-level constraints as
 * `{ constraints: { role_code_key: { unique: ['code'] } } }` — a constraint
 * NAME nested one level inside `options.constraints`, not one of the KINDS
 * (`unique`/`primaryKey`/`check`/`foreignKeys`/`exclude`) node-pg-migrate
 * 7.9.1's `parseConstraints` (`dist/operations/tables/shared.js`) actually
 * looks for. `CREATE TABLE` ran, but none of those constraints were ever
 * created — confirmed against `pg_constraint` on the live droplet: `role`
 * carries only its primary key, `role_permission` carries only its two
 * foreign keys. This is what crash-loops `svc-authz` in production
 * (`authz.repository.ts`'s `ON CONFLICT (code)` seeder has no unique
 * constraint to match against).
 *
 * The pre-existing test gap: a schema test that only regex-matches this
 * file's own SOURCE TEXT (the pattern every sibling service's
 * `*-schema.test.ts` uses) cannot catch this bug — the broken
 * `{ role_code_key: { unique: ['code'] } }` and a hypothetical fixed
 * `{ unique: ['code'] }` both "look like" a constraint declaration to a
 * string scanner; only actually running the options object through
 * node-pg-migrate's own constraint parser reveals that one produces SQL and
 * the other produces nothing. Every test below that asserts a constraint
 * exists does so by building real SQL through `MigrationBuilderImpl` (the
 * same class node-pg-migrate's own `Migration.apply()` constructs — see
 * `node_modules/node-pg-migrate/dist/migration.js`), not by reading source.
 *
 * The fix itself is a NEW migration, `1756100000000_authz-constraints-fix.js`
 * — not an edit to `1754100000000_authz-schema.js` — because the parent
 * migration already ran on `gadonghr-prod` (Task 16) and node-pg-migrate
 * never re-runs an applied migration; see that file's own header comment for
 * the full reasoning, including why the parent migration is deliberately
 * NOT "corrected" to the valid inline shape (doing so would make a
 * fresh-environment replay try to create every constraint twice).
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

interface AuthzMigrationModule {
  up: (pgm: MigrationBuilder) => void
  down: (pgm: MigrationBuilder) => void
}

function loadMigration(fragment: string): AuthzMigrationModule {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  const file = files.find((f) => f.includes(fragment))
  if (file === undefined) throw new Error(`no *${fragment}*.js migration file found in ${MIGRATIONS_DIR}`)
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, file)) as AuthzMigrationModule
}

/**
 * `MigrationBuilderImpl`'s constructor only touches `db` to hand
 * `pgm.db.query`/`pgm.db.select` through to a migration that calls them
 * directly — none of `svc-authz`'s migrations do (they only call
 * `createSchema`/`createTable`/`createIndex`/`addConstraint`/`sql`), so a
 * `db` that throws if ever actually invoked is a safe, honest stand-in for
 * "no Postgres in this environment" (Task 16c CONSTRAINTS, matching every
 * migration file's own precedent).
 */
const unreachableDb: DB = {
  query: () => {
    throw new Error('unreachable: this harness only builds SQL text, it never executes it')
  },
  select: () => {
    throw new Error('unreachable: this harness only builds SQL text, it never executes it')
  },
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * Runs `action` (a migration's `up` or `down`, or an ad-hoc `pgm` callback)
 * against node-pg-migrate's REAL `MigrationBuilder` and returns the exact
 * SQL it would emit — this is what actually catches Task 16c's defect,
 * where reading source text cannot.
 */
function buildSql(action: (pgm: MigrationBuilder) => void): string {
  const pgm = new MigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
  action(pgm)
  return pgm.getSql()
}

describe('authz schema migration — applies cleanly against a real MigrationBuilder', () => {
  it('the parent migration (authz-schema) runs without throwing', () => {
    const migration = loadMigration('authz-schema')
    expect(() => buildSql(migration.up)).not.toThrow()
  })

  it('the parent migration down() runs without throwing', () => {
    const migration = loadMigration('authz-schema')
    expect(() => buildSql(migration.down)).not.toThrow()
  })

  it('the constraints-fix migration runs without throwing', () => {
    const migration = loadMigration('authz-constraints-fix')
    expect(() => buildSql(migration.up)).not.toThrow()
  })

  it('the constraints-fix migration down() runs without throwing', () => {
    const migration = loadMigration('authz-constraints-fix')
    expect(() => buildSql(migration.down)).not.toThrow()
  })
})

describe('authz schema migration — the parent migration alone creates NO table-level constraint on role/role_permission (documents the historical defect)', () => {
  it('role has no ADD CONSTRAINT / inline CONSTRAINT clause for a UNIQUE on code', () => {
    const migration = loadMigration('authz-schema')
    const sql = buildSql(migration.up)
    const roleTable = /CREATE TABLE "authz"\."role" \([\s\S]*?\);/.exec(sql)?.[0] ?? ''
    expect(roleTable).not.toBe('')
    expect(roleTable).not.toMatch(/UNIQUE/)
  })

  it('role_permission has no PRIMARY KEY and no CHECK anywhere in the generated SQL', () => {
    const migration = loadMigration('authz-schema')
    const sql = buildSql(migration.up)
    const rolePermissionTable = /CREATE TABLE "authz"\."role_permission" \([\s\S]*?\);/.exec(sql)?.[0] ?? ''
    expect(rolePermissionTable).not.toBe('')
    expect(rolePermissionTable).not.toMatch(/PRIMARY KEY/)
    expect(rolePermissionTable).not.toMatch(/CHECK/)
  })
})

describe('authz schema migration — the constraints-fix migration actually creates every missing constraint', () => {
  it('creates role_code_key: UNIQUE (code) on authz.role', () => {
    const migration = loadMigration('authz-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ALTER TABLE "authz"\."role"\s+ADD CONSTRAINT "role_code_key" UNIQUE \("code"\);/,
    )
  })

  it('creates role_permission_pkey: composite PRIMARY KEY (role_id, permission_code) on authz.role_permission', () => {
    const migration = loadMigration('authz-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ALTER TABLE "authz"\."role_permission"\s+ADD CONSTRAINT "role_permission_pkey" PRIMARY KEY \("role_id", "permission_code"\);/,
    )
  })

  /**
   * THE security control (Security doc §4.2): no role, including System
   * Admin, may ever carry `biometric.template.read`. Until Task 16c's fix,
   * this was enforced nowhere in the database — only in `seed/roles.ts`'s
   * `assertNoBiometricGrant`, an application-level brace with no
   * corresponding DB-level belt. A guard that has never existed at the
   * layer it claims to is not a guard.
   */
  it('creates role_permission_no_biometric_check: CHECK (permission_code <> biometric.template.read) on authz.role_permission', () => {
    const migration = loadMigration('authz-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ALTER TABLE "authz"\."role_permission"\s+ADD CONSTRAINT "role_permission_no_biometric_check" CHECK \(permission_code <> 'biometric\.template\.read'\);/,
    )
  })

  it('de-duplicates role.code and role_permission rows before adding the unique/primary-key constraints (defensive against dirty live data)', () => {
    const migration = loadMigration('authz-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/DELETE FROM authz\.role a USING authz\.role b/)
    expect(sql).toMatch(/DELETE FROM authz\.role_permission a USING authz\.role_permission b/)
  })
})

describe('authz schema migration — regression proof: the ORIGINAL broken shape really does silently create nothing', () => {
  /**
   * This is the "fails against the old shape" demonstration Task 16c's
   * brief asks for, kept as a permanent regression test rather than a
   * one-off manual run: it reconstructs the EXACT broken options object
   * `1754100000000_authz-schema.js` used to declare (name nested inside
   * `constraints`, not a recognised kind) and proves — via the same real
   * `MigrationBuilderImpl` every other test in this file uses — that it
   * produces a table with no unique constraint at all. If node-pg-migrate
   * ever changed `parseConstraints` to recognise this shape too, this test
   * would fail, which is exactly the point: it would mean the "old shape"
   * stopped being broken, and the reasoning in this file's other tests
   * would need to be revisited.
   */
  it('createTable with the old { constraints: { role_code_key: { unique: [...] } } } shape produces no UNIQUE constraint', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'authz', name: 'role_regression_check' },
        { code: { type: 'text', notNull: true } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used, to prove node-pg-migrate really does ignore it.
        { constraints: { role_code_key: { unique: ['code'] } } } as any,
      )
    })
    expect(sql).toMatch(/CREATE TABLE "authz"\."role_regression_check"/)
    expect(sql).not.toMatch(/UNIQUE/)
    expect(sql).not.toMatch(/role_code_key/)
  })

  it('the CORRECT { constraints: { unique: [...] } } shape (for comparison) does create it', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'authz', name: 'role_regression_check_fixed' },
        { code: { type: 'text', notNull: true } },
        { constraints: { unique: ['code'] } },
      )
    })
    expect(sql).toMatch(/UNIQUE \("code"\)/)
  })
})
