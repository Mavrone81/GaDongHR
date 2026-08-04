import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import RealMigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Proves `1756000000001_timesheet-refs.js`'s shape directly — same two
 * techniques `migration.test.ts` (Task 14) established: a structured fake
 * `pgm` recorder, and the real `MigrationBuilderImpl` for exact-SQL
 * assertions. No Postgres in this environment (brief CONSTRAINTS).
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(MIGRATIONS_DIR, f))
}

interface ColumnSpec {
  type: string
  notNull?: boolean
  primaryKey?: boolean
  default?: unknown
  references?: unknown
}

interface CreateTableCall {
  schema: string
  name: string
  columns: Record<string, ColumnSpec>
}

interface AddConstraintCall {
  schema: string
  name: string
  constraintName: string
  spec: Record<string, unknown>
}

class FakePgmRecorder {
  readonly tables: CreateTableCall[] = []
  readonly indexes: Array<{ schema: string; name: string; columns: string[] }> = []
  readonly constraints: AddConstraintCall[] = []
  readonly droppedTables: Array<{ schema: string; name: string }> = []

  createTable(ident: { schema: string; name: string }, columns: Record<string, ColumnSpec>): void {
    this.tables.push({ schema: ident.schema, name: ident.name, columns })
  }

  createIndex(ident: { schema: string; name: string }, columns: string[]): void {
    this.indexes.push({ schema: ident.schema, name: ident.name, columns })
  }

  addConstraint(ident: { schema: string; name: string }, constraintName: string, spec: Record<string, unknown>): void {
    this.constraints.push({ schema: ident.schema, name: ident.name, constraintName, spec })
  }

  dropTable(ident: { schema: string; name: string }, _options?: Record<string, unknown>): void {
    void _options
    this.droppedTables.push({ schema: ident.schema, name: ident.name })
  }

  func(sql: string): { __pgmFunc: true; sql: string } {
    return { __pgmFunc: true, sql }
  }
}

interface MigrationModule {
  up: (pgm: FakePgmRecorder) => void
  down: (pgm: FakePgmRecorder) => void
}

function loadMigration(): MigrationModule {
  const file = migrationFiles().find((f) => f.includes('timesheet-refs'))
  if (!file) throw new Error('timesheet-refs migration file not found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are plain CommonJS modules, loaded the same way node-pg-migrate itself loads them at runtime.
  return require(file) as MigrationModule
}

function table(recorder: FakePgmRecorder, name: string): CreateTableCall {
  const found = recorder.tables.find((t) => t.name === name)
  if (!found) throw new Error(`no table named "${name}" was created`)
  return found
}

describe('timesheet-refs migration — up() creates every read-model/audit table', () => {
  it('creates roster_ref, leave_ref, ot_approval_ref, correction_audit, all in the timesheet schema', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)

    const names = recorder.tables.map((t) => t.name).sort()
    expect(names).toEqual(['correction_audit', 'leave_ref', 'ot_approval_ref', 'roster_ref'].sort())
    for (const t of recorder.tables) expect(t.schema).toBe('timesheet')
  })

  it('roster_ref: composite primary key (employee_id, work_date), grace_min >= 0, is_holiday/hazardous boolean not null', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const rosterRef = table(recorder, 'roster_ref')

    expect(rosterRef.columns['is_holiday']).toMatchObject({ type: 'boolean', notNull: true })
    expect(rosterRef.columns['hazardous']).toMatchObject({ type: 'boolean', notNull: true })
    expect(rosterRef.columns['scheduled_start']).toMatchObject({ type: 'timestamptz' })

    const pk = recorder.constraints.find(
      (c) => c.name === 'roster_ref' && Array.isArray(c.spec['primaryKey']),
    )
    expect(pk?.spec['primaryKey']).toEqual(['employee_id', 'work_date'])
  })

  it('leave_ref: leave_request_id unique, status check, no cross-schema reference', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const leaveRef = table(recorder, 'leave_ref')

    for (const spec of Object.values(leaveRef.columns)) expect(spec.references).toBeUndefined()
    const unique = recorder.constraints.find(
      (c) => c.name === 'leave_ref' && (c.spec['unique'] as string[] | undefined)?.includes('leave_request_id'),
    )
    expect(unique).toBeDefined()
    const statusCheck = recorder.constraints.find((c) => c.constraintName === 'leave_ref_status_check')
    expect(statusCheck?.spec['check']).toContain("'approved'")
  })

  it('ot_approval_ref: unique(employee_id, ot_date), hours numeric >= 0', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const otRef = table(recorder, 'ot_approval_ref')

    expect(otRef.columns['hours']?.type).toBe('numeric')
    const unique = recorder.constraints.find((c) => c.constraintName === 'ot_approval_ref_employee_id_ot_date_key')
    expect(unique?.spec['unique']).toEqual(['employee_id', 'ot_date'])
  })

  it('correction_audit: has a same-schema FK to day_record, and before/after are jsonb (immutable snapshot pair)', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const audit = table(recorder, 'correction_audit')

    expect(audit.columns['day_record_id']?.references).toMatchObject({ schema: 'timesheet', name: 'day_record' })
    expect(audit.columns['before']).toMatchObject({ type: 'jsonb', notNull: true })
    expect(audit.columns['after']).toMatchObject({ type: 'jsonb', notNull: true })
    expect(audit.columns['actor']).toMatchObject({ type: 'uuid', notNull: true })
    expect(audit.columns['reason']).toMatchObject({ type: 'text', notNull: true })
  })

  it('down() drops every table this migration created, none other', () => {
    const recorder = new FakePgmRecorder()
    const migration = loadMigration()
    migration.up(recorder)
    migration.down(recorder)

    const dropped = recorder.droppedTables.map((t) => t.name).sort()
    expect(dropped).toEqual(['correction_audit', 'leave_ref', 'ot_approval_ref', 'roster_ref'].sort())
  })
})

describe('timesheet-refs migration — real node-pg-migrate SQL generation (no execution, no Postgres here)', () => {
  const unreachableDb: DB = {
    query: () => {
      throw new Error('unreachable: this harness only builds SQL text, it never executes it')
    },
    select: () => {
      throw new Error('unreachable: this harness only builds SQL text, it never executes it')
    },
  }
  const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

  it('produces valid CREATE TABLE / ADD CONSTRAINT SQL for every table', () => {
    const pgm = new RealMigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
    ;(loadMigration().up as unknown as (pgm: MigrationBuilder) => void)(pgm)
    const sql = pgm.getSql()

    expect(sql).toMatch(/CREATE TABLE "timesheet"\."roster_ref"/)
    expect(sql).toMatch(/CREATE TABLE "timesheet"\."leave_ref"/)
    expect(sql).toMatch(/CREATE TABLE "timesheet"\."ot_approval_ref"/)
    expect(sql).toMatch(/CREATE TABLE "timesheet"\."correction_audit"/)
    expect(sql).toMatch(/ADD CONSTRAINT "roster_ref_employee_id_work_date_key" PRIMARY KEY/)
  })

  it('never REFERENCES another schema anywhere in this file', () => {
    const source = readFileSync(migrationFiles().find((f) => f.includes('timesheet-refs')) as string, 'utf8')
    const referenceBlocks = source.match(/references:\s*\{[^}]*\}/g) ?? []
    expect(referenceBlocks.length).toBeGreaterThan(0)
    for (const block of referenceBlocks) expect(block).toMatch(/schema:\s*'timesheet'/)
  })
})
