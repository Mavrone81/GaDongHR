import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Proves 1754500000100_leave-business.js's SQL shape directly, the same
 * three-strategy approach `leave-schema.test.ts` established for the parent
 * migration (regex-on-source, structural fake-builder run, real
 * `MigrationBuilderImpl` SQL inspection) — no Postgres in this environment.
 *
 * Scoped to what THIS migration adds; the parent migration's own columns
 * and constraints stay covered by `leave-schema.test.ts` unchanged.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function businessMigrationFile(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  const file = files.find((f) => f.includes('leave-business'))
  if (file === undefined) throw new Error('no *leave-business*.js migration file found')
  return file
}

function migrationSource(): string {
  return readFileSync(join(MIGRATIONS_DIR, businessMigrationFile()), 'utf8')
}

interface BusinessMigrationModule {
  up: (pgm: MigrationBuilder) => void
  down: (pgm: MigrationBuilder) => void
}

function loadMigration(): BusinessMigrationModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, businessMigrationFile())) as BusinessMigrationModule
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

function buildSql(action: (pgm: MigrationBuilder) => void): string {
  const pgm = new MigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
  action(pgm)
  return pgm.getSql()
}

describe('leave-business migration — applies cleanly', () => {
  it('exports.up runs against the real MigrationBuilder without throwing', () => {
    const migration = loadMigration()
    expect(() => buildSql(migration.up)).not.toThrow()
  })

  it('exports.down runs against the real MigrationBuilder without throwing', () => {
    const migration = loadMigration()
    expect(() => buildSql(migration.down)).not.toThrow()
  })
})

describe('leave-business migration — new numeric columns are numeric, never real/double precision', () => {
  const NUMERIC_COLUMNS = ['entitlement_days', 'pay_rate_percent', 'cert_trigger_days', 'min_days', 'delta'] as const

  it.each(NUMERIC_COLUMNS)('%s is declared numeric, by name', (column) => {
    const source = migrationSource()
    const columnMatch = new RegExp(`\\b${column}:\\s*\\{[^}]*\\}`).exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'numeric'/)
  })

  it('there is no real/double precision column anywhere in this migration', () => {
    const source = migrationSource()
    expect(source).not.toMatch(/type:\s*'real'/)
    expect(source).not.toMatch(/type:\s*'double precision'/)
  })

  it('the "entitlement_days is numeric" assertion FAILS when changed to double precision', () => {
    const source = migrationSource()
    const mutated = source.replace('entitlement_days: { type: \'numeric\' }', "entitlement_days: { type: 'double precision' }")
    expect(mutated).not.toEqual(source)
    const columnMatch = /entitlement_days:\s*\{[^}]*\}/.exec(mutated)
    expect(columnMatch?.[0]).not.toMatch(/type:\s*'numeric'/)
  })
})

describe('leave-business migration — no new bytea column (attachment_ref stays the only one)', () => {
  it('this migration introduces zero bytea columns', () => {
    const source = migrationSource()
    expect(source).not.toMatch(/type:\s*'bytea'/)
  })
})

describe('leave-business migration — carry_over_enabled defaults OFF at the column level', () => {
  it('leave_type.carry_over_enabled has default: false (seeding "annual" to true is a service-layer decision, not a schema default)', () => {
    const source = migrationSource()
    const columnMatch = /carry_over_enabled:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/default:\s*false/)
  })
})

describe('leave-business migration — real SQL for new constraints/tables', () => {
  it('leave_request_half_day_period_check restricts to AM/PM or null', () => {
    const migration = loadMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "leave_request_half_day_period_check" CHECK \(half_day_period IS NULL OR half_day_period IN \('AM', 'PM'\)\);/,
    )
  })

  it('approval_level_type_level_key: UNIQUE (leave_type_id, level)', () => {
    const migration = loadMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "approval_level_type_level_key" UNIQUE \("leave_type_id", "level"\);/)
  })

  it('approver_delegation_range_check enforces ends_on >= starts_on', () => {
    const migration = loadMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "approver_delegation_range_check" CHECK \(ends_on >= starts_on\);/)
  })

  it('balance_ledger references leave_type within the leave schema (no cross-schema FK)', () => {
    const migration = loadMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/CONSTRAINT "balance_ledger_leave_type_id_fkey" REFERENCES "leave"\."leave_type"/)
  })

  it('approval_step.decided_by is a nullable uuid, distinct from approver_id', () => {
    const source = migrationSource()
    const columnMatch = /decided_by:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'uuid'/)
    expect(columnMatch?.[0]).not.toMatch(/notNull:\s*true/)
  })
})
