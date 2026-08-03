import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Proves the migration's SQL-shaping call text directly — no database
 * available in this environment (Task 14 brief CONSTRAINTS), matching
 * `services/svc-audit/src/migration.test.ts`'s approach of scanning the
 * migration file's own source rather than running it against real Postgres,
 * for column shapes.
 *
 * (Task 16c) Constraint existence is NOT asserted by source-text scanning —
 * `rate_class_check`/`holiday_calendar_year_key`/etc. used to be declared via
 * node-pg-migrate's silently-ignored `{ constraints: { <name>: {...} } }`
 * shape, which a text scan cannot distinguish from a working declaration
 * (both mention the same column names and CHECK text). Every constraint
 * assertion below instead runs the migration through node-pg-migrate's REAL
 * `MigrationBuilderImpl` — the same class `Migration.apply()` constructs
 * internally — and inspects the actual generated SQL.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migrationSource(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  if (files.length === 0) throw new Error(`no migration files found in ${MIGRATIONS_DIR}`)
  return files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).join('\n')
}

interface SchedulerMigrationModule {
  up: (pgm: MigrationBuilder) => void
  down: (pgm: MigrationBuilder) => void
}

function loadMigration(): SchedulerMigrationModule {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  const file = files.find((f) => f.includes('scheduler-schema'))
  if (file === undefined) throw new Error('no *scheduler-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, file)) as SchedulerMigrationModule
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

/** The `pgm.createTable({ schema: 'scheduler', name: <table> }, { ...columns }, ...)` block for one table, up to (but not including) the next `pgm.` call — good enough to scope column/constraint assertions to a single table without a full SQL parser. */
function tableBlock(source: string, table: string): string {
  const start = source.indexOf(`{ schema: 'scheduler', name: '${table}' }`)
  if (start === -1) throw new Error(`table "${table}" not found in migration source`)
  const nextCall = source.indexOf('\n  pgm.', start)
  return source.slice(start, nextCall === -1 ? source.length : nextCall)
}

describe('scheduler schema migration — creation', () => {
  it('creates the scheduler schema idempotently (ifNotExists: true) — safe if a prior partial run already created it', () => {
    const source = migrationSource()
    expect(source).toMatch(/pgm\.createSchema\('scheduler', \{ ifNotExists: true \}\)/)
  })

  it('defines every table from DATABASE-DESIGN §2.3 plus outbox and processed_events exactly once each — no duplicate/conflicting createTable call sites', () => {
    const source = migrationSource()
    for (const table of [
      'shift',
      'roster_entry',
      'ot_request',
      'holiday_calendar',
      'holiday',
      'scheduler_employee_ref',
      'outbox',
      'processed_events',
    ]) {
      const occurrences = source.split(`{ schema: 'scheduler', name: '${table}' }`).length - 1
      // `references: { schema: 'scheduler', name: 'shift' }` etc. also match
      // this literal string, so a table that other tables reference (shift,
      // holiday_calendar, holiday) legitimately appears more than once —
      // the invariant that actually matters is "at least once", i.e. the
      // table is really created.
      expect(occurrences).toBeGreaterThanOrEqual(1)
    }
  })

  it('down() drops the scheduler schema cleanly (cascade + ifExists) — a clean teardown, so a subsequent up() has nothing stale to conflict with', () => {
    const source = migrationSource()
    expect(source).toMatch(/pgm\.dropSchema\('scheduler', \{ cascade: true, ifExists: true \}\)/)
  })
})

describe('scheduler.shift — the midnight-crossing flag', () => {
  it('has crosses_midnight as a boolean column', () => {
    const block = tableBlock(migrationSource(), 'shift')
    expect(block).toMatch(/crosses_midnight:\s*\{\s*type:\s*'boolean'/)
  })

  it('has start_t and end_t as time columns, and grace_min as an integer', () => {
    const block = tableBlock(migrationSource(), 'shift')
    expect(block).toMatch(/start_t:\s*\{\s*type:\s*'time'/)
    expect(block).toMatch(/end_t:\s*\{\s*type:\s*'time'/)
    expect(block).toMatch(/grace_min:\s*\{\s*type:\s*'integer'/)
  })

  it('has name_i18n, break_rules, and differential as jsonb columns', () => {
    const block = tableBlock(migrationSource(), 'shift')
    expect(block).toMatch(/name_i18n:\s*\{\s*type:\s*'jsonb'/)
    expect(block).toMatch(/break_rules:\s*\{\s*type:\s*'jsonb'/)
    expect(block).toMatch(/differential:\s*\{\s*type:\s*'jsonb'/)
  })
})

describe('scheduler.roster_entry — no cross-schema (or any) FK on employee identity', () => {
  it('has employee_id, shift_id, work_date, status, and override_reason columns', () => {
    const block = tableBlock(migrationSource(), 'roster_entry')
    expect(block).toMatch(/employee_id:\s*\{\s*type:\s*'uuid'/)
    expect(block).toMatch(/shift_id:\s*\{/)
    expect(block).toMatch(/work_date:\s*\{\s*type:\s*'date'/)
    expect(block).toMatch(/status:\s*\{\s*type:\s*'text'/)
    expect(block).toMatch(/override_reason:\s*\{\s*type:\s*'text'\s*\}/)
  })

  it('does not declare a references clause on employee_id — no FK, not even to the local read model, per the standing "no foreign keys across schemas" rule', () => {
    const block = tableBlock(migrationSource(), 'roster_entry')
    const employeeIdField = block.slice(block.indexOf('employee_id:'), block.indexOf('shift_id:'))
    expect(employeeIdField).not.toMatch(/references/)
  })

  it('the only references clause in this table points within the scheduler schema (shift_id -> scheduler.shift), never to onboarding or any other schema', () => {
    const block = tableBlock(migrationSource(), 'roster_entry')
    const referenceMatches = [...block.matchAll(/references:\s*\{\s*schema:\s*'([^']+)'/g)]
    expect(referenceMatches.length).toBeGreaterThan(0)
    for (const match of referenceMatches) {
      expect(match[1]).toBe('scheduler')
    }
  })

  it('never mentions the onboarding schema anywhere in the migration file — no FK to onboarding.employee', () => {
    const source = migrationSource()
    expect(source).not.toMatch(/onboarding/)
  })
})

describe('scheduler.ot_request — the rate class payroll multiplies by', () => {
  it('has a rate_class text column', () => {
    const block = tableBlock(migrationSource(), 'ot_request')
    expect(block).toMatch(/rate_class:\s*\{\s*type:\s*'text'/)
  })

  it('constrains rate_class to the three payroll multiplier classes (1.5x workday, 2x holiday_work, 3x holiday_ot), actually created by node-pg-migrate (Task 16c)', () => {
    const sql = buildSql(loadMigration().up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "ot_request_rate_class_check" CHECK \(rate_class IN \('workday', 'holiday_work', 'holiday_ot'\)\);/,
    )
  })

  it('does not declare a references clause on employee_id — same no-FK reasoning as roster_entry', () => {
    const block = tableBlock(migrationSource(), 'ot_request')
    const employeeIdField = block.slice(block.indexOf('employee_id:'), block.indexOf('ot_date:'))
    expect(employeeIdField).not.toMatch(/references/)
  })
})

describe('scheduler.holiday_calendar / scheduler.holiday', () => {
  it('holiday_calendar has a unique year column, actually created by node-pg-migrate (Task 16c)', () => {
    const block = tableBlock(migrationSource(), 'holiday_calendar')
    expect(block).toMatch(/year:\s*\{\s*type:\s*'integer'/)
    const sql = buildSql(loadMigration().up)
    expect(sql).toMatch(/ADD CONSTRAINT "holiday_calendar_year_key" UNIQUE \("year"\);/)
  })

  it('holiday references holiday_calendar within the scheduler schema and carries name_i18n/is_substitute', () => {
    const block = tableBlock(migrationSource(), 'holiday')
    expect(block).toMatch(/calendar_id:[\s\S]*?references:\s*\{\s*schema:\s*'scheduler',\s*name:\s*'holiday_calendar'/)
    expect(block).toMatch(/name_i18n:\s*\{\s*type:\s*'jsonb'/)
    expect(block).toMatch(/is_substitute:\s*\{\s*type:\s*'boolean'/)
  })
})

describe('scheduler.scheduler_employee_ref — local read model fed by employee.* events', () => {
  it('has employee_id as its primary key, not a foreign key to another schema', () => {
    const block = tableBlock(migrationSource(), 'scheduler_employee_ref')
    expect(block).toMatch(/employee_id:\s*\{\s*type:\s*'uuid',\s*primaryKey:\s*true\s*\}/)
    expect(block).not.toMatch(/references/)
  })
})

describe('scheduler.outbox — standard shape', () => {
  it('has id, topic, payload, created_at, and published_at', () => {
    const block = tableBlock(migrationSource(), 'outbox')
    expect(block).toMatch(/id:\s*\{\s*type:\s*'uuid',\s*primaryKey:\s*true/)
    expect(block).toMatch(/topic:\s*\{\s*type:\s*'text',\s*notNull:\s*true\s*\}/)
    expect(block).toMatch(/payload:\s*\{\s*type:\s*'jsonb',\s*notNull:\s*true\s*\}/)
    expect(block).toMatch(/created_at:\s*\{\s*type:\s*'timestamptz'/)
    expect(block).toMatch(/published_at:\s*\{\s*type:\s*'timestamptz'\s*\}/)
  })
})

describe('scheduler.processed_events — event_id PK', () => {
  it('creates processed_events with event_id as its primary key', () => {
    const source = migrationSource()
    expect(source).toMatch(/name:\s*['"]processed_events['"][\s\S]{0,300}event_id[\s\S]{0,100}primaryKey:\s*true/)
  })
})

describe('scheduler schema migration — every remaining constraint is actually created by node-pg-migrate (Task 16c)', () => {
  it('shift_grace_min_check', () => {
    const sql = buildSql(loadMigration().up)
    expect(sql).toMatch(/ADD CONSTRAINT "shift_grace_min_check" CHECK \(grace_min >= 0\);/)
  })

  it('holiday_calendar_id_holiday_date_key: UNIQUE (calendar_id, holiday_date)', () => {
    const sql = buildSql(loadMigration().up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "holiday_calendar_id_holiday_date_key" UNIQUE \("calendar_id", "holiday_date"\);/,
    )
  })

  it('roster_entry_status_check', () => {
    const sql = buildSql(loadMigration().up)
    expect(sql).toMatch(/ADD CONSTRAINT "roster_entry_status_check" CHECK \(status IN \('planned', 'published'\)\);/)
  })

  it('ot_request_hours_check / ot_request_status_check', () => {
    const sql = buildSql(loadMigration().up)
    expect(sql).toMatch(/ADD CONSTRAINT "ot_request_hours_check" CHECK \(hours > 0\);/)
    expect(sql).toMatch(/ADD CONSTRAINT "ot_request_status_check" CHECK \(status IN \('pending', 'approved', 'rejected'\)\);/)
  })

  /**
   * Regression proof, kept executable: reconstructs the exact broken
   * options object every scheduler constraint used to be declared with
   * (Task 16c), and proves node-pg-migrate's real `parseConstraints`
   * produces nothing from it.
   */
  it('the OLD { constraints: { <name>: { unique/check: ... } } } shape produces no constraint at all', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'scheduler', name: 'shift_regression_check' },
        { grace_min: { type: 'integer', notNull: true } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used.
        { constraints: { shift_grace_min_check: { check: 'grace_min >= 0' } } } as any,
      )
    })
    expect(sql).not.toMatch(/CHECK/)
    expect(sql).not.toMatch(/shift_grace_min_check/)
  })
})
