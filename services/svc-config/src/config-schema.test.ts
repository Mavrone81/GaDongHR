import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Task 16c: `1754000000000_config-schema.js` declared every constraint on
 * `statutory_rule` as `{ constraints: { <chosen_name>: { unique/check: ... } } }`
 * — a constraint NAME nested one level inside `options.constraints`, not one
 * of the KINDS (`unique`/`check`/`primaryKey`/`foreignKeys`/`exclude`)
 * node-pg-migrate 7.9.1's `parseConstraints`
 * (`dist/operations/tables/shared.js`) actually destructures off that
 * object. `CREATE TABLE` ran, but none of `statutory_rule_rule_key_effective_from_key`,
 * `statutory_rule_governance_class_check`, `statutory_rule_status_check`, or
 * `statutory_rule_sod_check` were ever created — the identical silent-drop
 * bug found live in `svc-authz` (Task 16c).
 *
 * Reading this file's source text cannot catch the bug (the broken and a
 * hypothetically-fixed shape both "look like" a constraint declaration to a
 * text scanner), so every constraint-existence assertion below runs the
 * migration's options object through node-pg-migrate's own
 * `MigrationBuilderImpl` — the same class `Migration.apply()` constructs
 * internally (`node_modules/node-pg-migrate/dist/migration.js`) — and
 * inspects the actual generated SQL.
 *
 * The fix is a NEW migration, `1756100000000_config-constraints-fix.js`, not
 * an edit to `1754000000000_config-schema.js`: `config` is one of the seven
 * platform services in `deploy/docker-compose.prod.yml` (deployed at Task
 * 16), so the parent migration already ran on `gadonghr-prod` and
 * node-pg-migrate never re-runs an applied migration — see the fix
 * migration's own header for the full reasoning, including why the parent is
 * deliberately NOT "corrected" in place.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

interface ConfigMigrationModule {
  up: (pgm: MigrationBuilder) => void
  down: (pgm: MigrationBuilder) => void
}

function loadMigration(fragment: string): ConfigMigrationModule {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  const file = files.find((f) => f.includes(fragment))
  if (file === undefined) throw new Error(`no *${fragment}*.js migration file found in ${MIGRATIONS_DIR}`)
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, file)) as ConfigMigrationModule
}

/**
 * `MigrationBuilderImpl`'s constructor only touches `db` to hand
 * `pgm.db.query`/`pgm.db.select` through to a migration that calls them
 * directly — none of `svc-config`'s migrations do, so a `db` that throws if
 * ever actually invoked is a safe, honest stand-in for "no Postgres in this
 * environment".
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

/** Runs `action` against a real node-pg-migrate `MigrationBuilder` and returns the exact SQL it would emit. */
function buildSql(action: (pgm: MigrationBuilder) => void): string {
  const pgm = new MigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
  action(pgm)
  return pgm.getSql()
}

describe('config schema migration — applies cleanly against a real MigrationBuilder', () => {
  it('the parent migration (config-schema) runs without throwing', () => {
    const migration = loadMigration('config-schema')
    expect(() => buildSql(migration.up)).not.toThrow()
  })

  it('the parent migration down() runs without throwing', () => {
    const migration = loadMigration('config-schema')
    expect(() => buildSql(migration.down)).not.toThrow()
  })

  it('the constraints-fix migration runs without throwing', () => {
    const migration = loadMigration('config-constraints-fix')
    expect(() => buildSql(migration.up)).not.toThrow()
  })

  it('the constraints-fix migration down() runs without throwing', () => {
    const migration = loadMigration('config-constraints-fix')
    expect(() => buildSql(migration.down)).not.toThrow()
  })
})

describe('config schema migration — the parent migration alone creates NO table-level constraint on statutory_rule (documents the historical defect)', () => {
  it('statutory_rule has no ADD CONSTRAINT / inline CONSTRAINT clause at all', () => {
    const migration = loadMigration('config-schema')
    const sql = buildSql(migration.up)
    const table = /CREATE TABLE "config"\."statutory_rule" \([\s\S]*?\);/.exec(sql)?.[0] ?? ''
    expect(table).not.toBe('')
    expect(table).not.toMatch(/UNIQUE|CHECK|CONSTRAINT/)
  })
})

describe('config schema migration — the constraints-fix migration actually creates every missing constraint', () => {
  it('creates statutory_rule_rule_key_effective_from_key: UNIQUE (rule_key, effective_from)', () => {
    const migration = loadMigration('config-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "statutory_rule_rule_key_effective_from_key" UNIQUE \("rule_key", "effective_from"\);/,
    )
  })

  it('creates statutory_rule_governance_class_check', () => {
    const migration = loadMigration('config-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "statutory_rule_governance_class_check" CHECK \(governance_class IN \('STATUTORY_FLOOR', 'STATUTORY_FIXED', 'COMPANY_POLICY'\)\);/,
    )
  })

  it('creates statutory_rule_status_check', () => {
    const migration = loadMigration('config-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "statutory_rule_status_check" CHECK \(status IN \('draft', 'pending_approval', 'active', 'superseded'\)\);/,
    )
  })

  /**
   * Segregation of duties — a CORRECTNESS/COMPLIANCE control, the same
   * shape as `svc-payroll`'s `payroll_run_sod_check`: the proposer of a
   * statutory rule change may not also be its approver. Until Task 16c's
   * fix, this was enforced nowhere in the database — only in
   * `rules.service.ts`'s application-level check.
   */
  it('creates statutory_rule_sod_check: proposed_by IS NULL OR approved_by IS NULL OR proposed_by <> approved_by', () => {
    const migration = loadMigration('config-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "statutory_rule_sod_check" CHECK \(proposed_by IS NULL OR approved_by IS NULL OR proposed_by <> approved_by\);/,
    )
  })

  it('de-duplicates statutory_rule rows on (rule_key, effective_from) before adding the unique constraint (defensive against dirty live data)', () => {
    const migration = loadMigration('config-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/DELETE FROM config\.statutory_rule a USING config\.statutory_rule b/)
  })
})

describe('config schema migration — regression proof: the ORIGINAL broken shape really does silently create nothing', () => {
  /**
   * Permanent regression test (Task 16c's "demonstrate the improved test
   * fails against the old shape", kept executable rather than a one-off
   * manual run): reconstructs the exact broken options object the original
   * migration used and proves it produces a table with no SOD check at all.
   */
  it('createTable with the old { constraints: { statutory_rule_sod_check: { check: ... } } } shape produces no CHECK constraint', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'config', name: 'statutory_rule_regression_check' },
        {
          proposed_by: { type: 'uuid' },
          approved_by: { type: 'uuid' },
        },
        {
          constraints: {
            statutory_rule_sod_check: {
              check: 'proposed_by IS NULL OR approved_by IS NULL OR proposed_by <> approved_by',
            },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used, to prove node-pg-migrate really does ignore it.
        } as any,
      )
    })
    expect(sql).toMatch(/CREATE TABLE "config"\."statutory_rule_regression_check"/)
    expect(sql).not.toMatch(/CHECK/)
    expect(sql).not.toMatch(/statutory_rule_sod_check/)
  })

  it('the CORRECT { constraints: { check: ... } } shape (for comparison) does create it', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'config', name: 'statutory_rule_regression_check_fixed' },
        {
          proposed_by: { type: 'uuid' },
          approved_by: { type: 'uuid' },
        },
        {
          constraints: {
            check: 'proposed_by IS NULL OR approved_by IS NULL OR proposed_by <> approved_by',
          },
        },
      )
    })
    expect(sql).toMatch(/CHECK \(proposed_by IS NULL OR approved_by IS NULL OR proposed_by <> approved_by\)/)
  })
})
