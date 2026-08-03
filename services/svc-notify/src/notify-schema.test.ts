import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Task 16c: `1754200000000_notify-schema.js` declared every CHECK on
 * `notification`, `delivery`, and `recipient_pref` as
 * `{ constraints: { <chosen_name>: { check: '...' } } }` — a constraint NAME
 * nested one level inside `options.constraints`, not one of the KINDS
 * (`check`/`unique`/`primaryKey`/`foreignKeys`/`exclude`) node-pg-migrate
 * 7.9.1's `parseConstraints` (`dist/operations/tables/shared.js`) actually
 * destructures off that object. `CREATE TABLE` ran, but none of
 * `notification_lang_check`, `delivery_channel_check`,
 * `delivery_status_check`, or `recipient_pref_lang_check` were ever created —
 * the identical silent-drop bug found live in `svc-authz` (Task 16c).
 *
 * Reading this file's source text cannot catch the bug, so every
 * constraint-existence assertion below runs the migration's options object
 * through node-pg-migrate's own `MigrationBuilderImpl` — the same class
 * `Migration.apply()` constructs internally
 * (`node_modules/node-pg-migrate/dist/migration.js`) — and inspects the
 * actual generated SQL.
 *
 * The fix is a NEW migration, `1756100000000_notify-constraints-fix.js`, not
 * an edit to `1754200000000_notify-schema.js`: `notify` is one of the seven
 * platform services in `deploy/docker-compose.prod.yml` (deployed at Task
 * 16), so the parent migration already ran on `gadonghr-prod` and
 * node-pg-migrate never re-runs an applied migration — see the fix
 * migration's own header for the full reasoning.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

interface NotifyMigrationModule {
  up: (pgm: MigrationBuilder) => void
  down: (pgm: MigrationBuilder) => void
}

function loadMigration(fragment: string): NotifyMigrationModule {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  const file = files.find((f) => f.includes(fragment))
  if (file === undefined) throw new Error(`no *${fragment}*.js migration file found in ${MIGRATIONS_DIR}`)
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, file)) as NotifyMigrationModule
}

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

describe('notify schema migration — applies cleanly against a real MigrationBuilder', () => {
  it('the parent migration (notify-schema) runs without throwing', () => {
    const migration = loadMigration('notify-schema')
    expect(() => buildSql(migration.up)).not.toThrow()
  })

  it('the parent migration down() runs without throwing', () => {
    const migration = loadMigration('notify-schema')
    expect(() => buildSql(migration.down)).not.toThrow()
  })

  it('the constraints-fix migration runs without throwing', () => {
    const migration = loadMigration('notify-constraints-fix')
    expect(() => buildSql(migration.up)).not.toThrow()
  })

  it('the constraints-fix migration down() runs without throwing', () => {
    const migration = loadMigration('notify-constraints-fix')
    expect(() => buildSql(migration.down)).not.toThrow()
  })
})

describe('notify schema migration — the parent migration alone creates NO CHECK constraints (documents the historical defect)', () => {
  it('notification/delivery/recipient_pref carry no CHECK anywhere in the generated SQL', () => {
    const migration = loadMigration('notify-schema')
    const sql = buildSql(migration.up)
    for (const table of ['notification', 'delivery', 'recipient_pref']) {
      const tableSql = new RegExp(`CREATE TABLE "notify"\\."${table}" \\([\\s\\S]*?\\);`).exec(sql)?.[0] ?? ''
      expect(tableSql).not.toBe('')
      expect(tableSql).not.toMatch(/CHECK/)
    }
  })
})

describe('notify schema migration — the constraints-fix migration actually creates every missing CHECK', () => {
  it('creates notification_lang_check: lang IN (th, en, zh)', () => {
    const migration = loadMigration('notify-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "notification_lang_check" CHECK \(lang IN \('th', 'en', 'zh'\)\);/,
    )
  })

  it('creates delivery_channel_check: channel IN (in_app, email)', () => {
    const migration = loadMigration('notify-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "delivery_channel_check" CHECK \(channel IN \('in_app', 'email'\)\);/,
    )
  })

  it('creates delivery_status_check: status IN (sent, failed)', () => {
    const migration = loadMigration('notify-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "delivery_status_check" CHECK \(status IN \('sent', 'failed'\)\);/,
    )
  })

  it('creates recipient_pref_lang_check: lang IN (th, en, zh)', () => {
    const migration = loadMigration('notify-constraints-fix')
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "recipient_pref_lang_check" CHECK \(lang IN \('th', 'en', 'zh'\)\);/,
    )
  })
})

describe('notify schema migration — regression proof: the ORIGINAL broken shape really does silently create nothing', () => {
  it('createTable with the old { constraints: { notification_lang_check: { check: ... } } } shape produces no CHECK constraint', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'notify', name: 'notification_regression_check' },
        { lang: { type: 'text', notNull: true } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used, to prove node-pg-migrate really does ignore it.
        { constraints: { notification_lang_check: { check: "lang IN ('th', 'en', 'zh')" } } } as any,
      )
    })
    expect(sql).toMatch(/CREATE TABLE "notify"\."notification_regression_check"/)
    expect(sql).not.toMatch(/CHECK/)
    expect(sql).not.toMatch(/notification_lang_check/)
  })

  it('the CORRECT { constraints: { check: ... } } shape (for comparison) does create it', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'notify', name: 'notification_regression_check_fixed' },
        { lang: { type: 'text', notNull: true } },
        { constraints: { check: "lang IN ('th', 'en', 'zh')" } },
      )
    })
    expect(sql).toMatch(/CHECK \(lang IN \('th', 'en', 'zh'\)\)/)
  })
})
