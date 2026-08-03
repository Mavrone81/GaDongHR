import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Proves `1754800000001_claims-workflow.js`'s SQL shape — same technique
 * `claims-schema.test.ts` uses for the base migration (no Postgres in this
 * environment). Focused on the two properties the Task 14 brief calls out:
 * `claim_type.*_limit`/`approval_band.max_amount` are numeric (never
 * float), and the config seed for M6-3's banding is present as DATA, not a
 * code fallback.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migrationFile(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  const file = files.find((f) => f.includes('claims-workflow'))
  if (file === undefined) throw new Error('no *claims-workflow*.js migration file found')
  return file
}

function migrationSource(): string {
  return readFileSync(join(MIGRATIONS_DIR, migrationFile()), 'utf8')
}

function loadMigration(): { up: (pgm: MigrationBuilder) => void; down: (pgm: MigrationBuilder) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, migrationFile())) as {
    up: (pgm: MigrationBuilder) => void
    down: (pgm: MigrationBuilder) => void
  }
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

describe('claims workflow migration — applies cleanly', () => {
  it('exports.up runs against the real MigrationBuilder without throwing', () => {
    const migration = loadMigration()
    expect(() => buildSql(migration.up)).not.toThrow()
  })

  it('exports.down runs against the real MigrationBuilder without throwing', () => {
    const migration = loadMigration()
    expect(() => buildSql(migration.down)).not.toThrow()
  })
})

describe('claims workflow migration — claim_type / approval_band amounts are numeric, never real/double precision', () => {
  const NUMERIC_COLUMNS = ['per_claim_limit', 'monthly_limit', 'annual_limit', 'mileage_rate']

  it.each(NUMERIC_COLUMNS)('claim_type.%s is declared numeric, by name', (column) => {
    const source = migrationSource()
    const columnMatch = new RegExp(`\\b${column}:\\s*\\{[^}]*\\}`).exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'numeric'/)
  })

  it('approval_band.max_amount is declared numeric, by name', () => {
    const source = migrationSource()
    const columnMatch = /max_amount:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'numeric'/)
  })

  it('there is no real/double precision column anywhere in this migration', () => {
    const source = migrationSource()
    expect(source).not.toMatch(/type:\s*'real'/)
    expect(source).not.toMatch(/type:\s*'double precision'/)
  })

  it('the "max_amount is numeric" assertion FAILS when changed to double precision — demonstrating the check is load-bearing', () => {
    const source = migrationSource()
    const mutated = source.replace("max_amount: { type: 'numeric' }", "max_amount: { type: 'double precision' }")
    expect(mutated).not.toEqual(source)
    const columnMatch = /max_amount:\s*\{[^}]*\}/.exec(mutated)
    expect(columnMatch?.[0]).not.toMatch(/type:\s*'numeric'/)
  })
})

describe('claims workflow migration — approval_band is seeded as DATA (M6-3 config, not a code fallback)', () => {
  it('seeds exactly the PRD worked example: <=2000 manager only, >2000 manager+finance', () => {
    const source = migrationSource()
    expect(source).toMatch(/INSERT INTO claims\.approval_band[\s\S]*\(2000, '\["manager"\]'::jsonb, 1\)/)
    expect(source).toMatch(/\(NULL, '\["manager", "finance"\]'::jsonb, 2\)/)
  })

  it('approval_band has a UNIQUE constraint on sort_order — actually created by node-pg-migrate', () => {
    const migration = loadMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "approval_band_sort_order_key" UNIQUE \("sort_order"\)/)
  })
})

describe('claims workflow migration — claim_type limit-kind CHECK constraints actually exist', () => {
  it.each(['per_claim_limit_kind', 'monthly_limit_kind', 'annual_limit_kind'])('%s CHECK is created by node-pg-migrate', (col) => {
    const migration = loadMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(new RegExp(`ADD CONSTRAINT "claim_type_${col}_check" CHECK \\(${col} IS NULL OR ${col} IN \\('hard', 'soft'\\)\\)`))
  })
})

describe('claims workflow migration — every new claim.* column from the M6-3/M6-4 workflow is present', () => {
  it('claim has claim_date, vendor, mileage_km, vat_amount, reimbursement_route, rejection_reason, round, soft_limit_warning, fields', () => {
    const source = migrationSource()
    for (const column of [
      'claim_date',
      'vendor',
      'mileage_km',
      'vat_amount',
      'reimbursement_route',
      'rejection_reason',
      'round',
      'soft_limit_warning',
      'fields',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('approval_step2 gains a round column', () => {
    const source = migrationSource()
    expect(source).toMatch(/round:\s*\{\s*type:\s*'integer'/)
  })
})
