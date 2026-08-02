import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Proves the `timesheet` schema migration's shape directly — no database
 * available in this environment (Task 14 brief CONSTRAINTS). Two
 * complementary techniques, both used elsewhere in this repo:
 *
 *  - A structured **fake `pgm` recorder**, in the spirit of
 *    `services/svc-config/src/testing/fake-db.ts`: `exports.up` is invoked
 *    for real against a minimal stand-in for node-pg-migrate's builder, so
 *    assertions read the actual `{type, notNull, ...}` column specs the
 *    migration passes, not a regex approximation of them. This is what
 *    proves "the three OT columns are numeric, not real/double precision"
 *    precisely.
 *  - **Source-text regex** (matching `services/svc-audit/src/migration.test.ts`)
 *    for properties that are about the *absence* of something (no
 *    cross-schema `REFERENCES`) or about exact SQL fragments (`UNIQUE`,
 *    `CHECK`) the recorder doesn't need to model in detail.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migrationFiles(): string[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  if (files.length === 0) throw new Error(`no migration files found in ${MIGRATIONS_DIR}`)
  return files.map((f) => join(MIGRATIONS_DIR, f))
}

function migrationSource(): string {
  return migrationFiles()
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
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
  options: Record<string, unknown>
}

interface CreateSchemaCall {
  name: string
  options: Record<string, unknown>
}

/**
 * A minimal, permissive stand-in for node-pg-migrate's `pgm` builder —
 * enough surface for this migration file to run against, recording every
 * call rather than issuing SQL. `func()` returns a tagged string so a test
 * can tell "this default came from `pgm.func(...)`" apart from a literal
 * JS value (e.g. `0`) without needing a real Postgres function evaluator.
 */
class FakePgmRecorder {
  readonly schemas: CreateSchemaCall[] = []
  readonly tables: CreateTableCall[] = []
  readonly indexes: Array<{ schema: string; name: string; columns: string[]; options: Record<string, unknown> }> = []
  private readonly existingSchemas = new Set<string>()
  private readonly existingTables = new Set<string>()

  createSchema(name: string, options: Record<string, unknown> = {}): void {
    if (this.existingSchemas.has(name) && options['ifNotExists'] !== true) {
      throw new Error(`FakePgmRecorder: schema "${name}" already exists`)
    }
    this.existingSchemas.add(name)
    this.schemas.push({ name, options })
  }

  createTable(
    ident: { schema: string; name: string },
    columns: Record<string, ColumnSpec>,
    options: Record<string, unknown> = {},
  ): void {
    const key = `${ident.schema}.${ident.name}`
    if (this.existingTables.has(key)) {
      throw new Error(`FakePgmRecorder: table "${key}" already exists`)
    }
    this.existingTables.add(key)
    this.tables.push({ schema: ident.schema, name: ident.name, columns, options })
  }

  createIndex(
    ident: { schema: string; name: string },
    columns: string[],
    options: Record<string, unknown> = {},
  ): void {
    this.indexes.push({ schema: ident.schema, name: ident.name, columns, options })
  }

  func(sql: string): { __pgmFunc: true; sql: string } {
    return { __pgmFunc: true, sql }
  }

  dropSchema(_name: string, _options?: Record<string, unknown>): void {
    void _name
    void _options
  }
}

interface MigrationModule {
  up: (pgm: FakePgmRecorder) => void
  down: (pgm: FakePgmRecorder) => void
}

function loadMigration(): MigrationModule {
  const files = migrationFiles()
  const timesheetFile = files.find((f) => f.includes('timesheet-schema'))
  if (!timesheetFile) throw new Error('timesheet-schema migration file not found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are plain CommonJS modules, loaded the same way node-pg-migrate itself loads them at runtime.
  return require(timesheetFile) as MigrationModule
}

function table(recorder: FakePgmRecorder, name: string): CreateTableCall {
  const found = recorder.tables.find((t) => t.name === name)
  if (!found) throw new Error(`no table named "${name}" was created`)
  return found
}

describe('timesheet schema migration — applies cleanly and is idempotent', () => {
  it('up() runs without throwing against a fresh fake pgm and creates every table the ERD specifies', () => {
    const recorder = new FakePgmRecorder()
    const migration = loadMigration()

    expect(() => migration.up(recorder)).not.toThrow()

    const tableNames = recorder.tables.map((t) => t.name).sort()
    expect(tableNames).toEqual(
      ['day_record', 'outbox', 'period', 'processed_events', 'time_exception', 'timesheet_employee_ref'].sort(),
    )
    for (const t of recorder.tables) expect(t.schema).toBe('timesheet')
  })

  it('createSchema uses ifNotExists: true — safe if main.ts\'s own createSchema:true bootstrap already created it', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)

    expect(recorder.schemas).toEqual([{ name: 'timesheet', options: { ifNotExists: true } }])
  })

  it('up() is deterministic: run against two independent fresh recorders, it produces the same table/column shape both times', () => {
    const migration = loadMigration()
    const first = new FakePgmRecorder()
    const second = new FakePgmRecorder()

    migration.up(first)
    migration.up(second)

    const shape = (r: FakePgmRecorder): unknown =>
      r.tables.map((t) => ({ name: t.name, columns: Object.keys(t.columns).sort() }))
    expect(shape(first)).toEqual(shape(second))
  })

  it("main.ts configures node-pg-migrate's migrationsTable, the mechanism that skips already-applied migrations on a re-run (so `pnpm migrate` twice is a safe no-op the second time)", () => {
    const mainSource = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    expect(mainSource).toMatch(/migrationsTable:\s*['"]pgmigrations['"]/)
    expect(mainSource).toMatch(/createSchema:\s*true/)
  })
})

describe('timesheet schema migration — day_record', () => {
  it('has all three OT rate-class columns, separately, each numeric', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const dayRecord = table(recorder, 'day_record')

    for (const col of ['ot_15x', 'ot_2x', 'ot_3x']) {
      expect(dayRecord.columns[col]).toBeDefined()
      expect(dayRecord.columns[col]?.type).toBe('numeric')
    }
    // Separately named, not a single total collapsed with a rate-class column.
    expect(dayRecord.columns['ot_hours']).toBeUndefined()
    expect(dayRecord.columns['rate_class']).toBeUndefined()
  })

  it('worked_hours and late_min are numeric — never real or double precision', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const dayRecord = table(recorder, 'day_record')

    expect(dayRecord.columns['worked_hours']?.type).toBe('numeric')
    expect(dayRecord.columns['late_min']?.type).toBe('numeric')
    for (const col of ['worked_hours', 'late_min', 'ot_15x', 'ot_2x', 'ot_3x']) {
      expect(dayRecord.columns[col]?.type).not.toBe('real')
      expect(dayRecord.columns[col]?.type).not.toBe('double precision')
      expect(dayRecord.columns[col]?.type).not.toBe('float')
    }
  })

  it('has every ERD column with the right shape (id pk, employee_id, work_date, roster_entry_id nullable, actual_in/out timestamptz, leave_code nullable, status)', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const dayRecord = table(recorder, 'day_record')

    expect(dayRecord.columns['id']).toMatchObject({ type: 'uuid', primaryKey: true })
    expect(dayRecord.columns['employee_id']).toMatchObject({ type: 'uuid', notNull: true })
    expect(dayRecord.columns['work_date']).toMatchObject({ type: 'date', notNull: true })
    expect(dayRecord.columns['roster_entry_id']).toMatchObject({ type: 'uuid' })
    expect(dayRecord.columns['roster_entry_id']?.notNull).not.toBe(true)
    expect(dayRecord.columns['actual_in']).toMatchObject({ type: 'timestamptz' })
    expect(dayRecord.columns['actual_out']).toMatchObject({ type: 'timestamptz' })
    expect(dayRecord.columns['leave_code']).toMatchObject({ type: 'text' })
    expect(dayRecord.columns['leave_code']?.notNull).not.toBe(true)
    expect(dayRecord.columns['status']).toMatchObject({ type: 'text', notNull: true })
  })

  it('declares no `references` on any column — day_record has no foreign key to any other schema', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const dayRecord = table(recorder, 'day_record')

    for (const spec of Object.values(dayRecord.columns)) {
      expect(spec.references).toBeUndefined()
    }
  })

  it('the migration source never REFERENCES another schema from timesheet.day_record (belt: source-text scan, not just the recorder)', () => {
    const source = migrationSource()
    const dayRecordBlock = /createTable\(\s*\{\s*schema:\s*'timesheet',\s*name:\s*'day_record'[\s\S]*?\n\s*\)\n/.exec(
      source,
    )?.[0]
    expect(dayRecordBlock).toBeDefined()
    // Matches an actual `references:` column option, not the word
    // "references" appearing in this block's own prose comments (which
    // explain, in English, why there is deliberately no such option).
    expect(dayRecordBlock).not.toMatch(/references\s*:/i)
  })

  it('enforces one row per employee per day via a UNIQUE(employee_id, work_date) constraint', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const dayRecord = table(recorder, 'day_record')
    const constraints = dayRecord.options['constraints'] as Record<string, { unique?: string[] }> | undefined

    const uniqueConstraint = Object.values(constraints ?? {}).find(
      (c) => Array.isArray(c.unique) && c.unique.includes('employee_id') && c.unique.includes('work_date'),
    )
    expect(uniqueConstraint).toBeDefined()
  })
})

describe('timesheet schema migration — period', () => {
  it('has lock_version as an integer column', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const period = table(recorder, 'period')

    expect(period.columns['lock_version']).toBeDefined()
    expect(period.columns['lock_version']?.type).toBe('integer')
  })

  it('range is a daterange column with a UNIQUE constraint (period_range_key)', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const period = table(recorder, 'period')

    expect(period.columns['range']).toMatchObject({ type: 'daterange', notNull: true })
    const constraints = period.options['constraints'] as Record<string, { unique?: string[] | string }> | undefined
    const rangeUnique = Object.values(constraints ?? {}).find((c) => {
      const cols = Array.isArray(c.unique) ? c.unique : c.unique !== undefined ? [c.unique] : []
      return cols.includes('range')
    })
    expect(rangeUnique).toBeDefined()
  })

  it('also carries locked_by and locked_at, and status/lock_version columns per the ERD', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const period = table(recorder, 'period')

    expect(period.columns['status']).toMatchObject({ type: 'text', notNull: true })
    expect(period.columns['locked_by']).toMatchObject({ type: 'uuid' })
    expect(period.columns['locked_at']).toMatchObject({ type: 'timestamptz' })
  })
})

describe('timesheet schema migration — time_exception', () => {
  it('has a foreign key to timesheet.day_record (same-schema FK is fine — only cross-schema FKs are forbidden)', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const exception = table(recorder, 'time_exception')

    expect(exception.columns['day_record_id']?.references).toMatchObject({ schema: 'timesheet', name: 'day_record' })
  })

  it('has kind, resolution, resolved_by and reason columns per the ERD', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const exception = table(recorder, 'time_exception')

    expect(exception.columns['kind']).toMatchObject({ type: 'text', notNull: true })
    expect(exception.columns['resolution']).toMatchObject({ type: 'text' })
    expect(exception.columns['resolved_by']).toMatchObject({ type: 'uuid' })
    expect(exception.columns['reason']).toMatchObject({ type: 'text' })
  })
})

describe('timesheet schema migration — outbox and processed_events', () => {
  it('creates outbox with the standard shape (id, topic, payload, created_at, published_at)', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const outbox = table(recorder, 'outbox')

    expect(outbox.columns['id']).toMatchObject({ type: 'uuid', primaryKey: true })
    expect(outbox.columns['topic']).toMatchObject({ type: 'text', notNull: true })
    expect(outbox.columns['payload']).toMatchObject({ type: 'jsonb', notNull: true })
    expect(outbox.columns['created_at']).toMatchObject({ type: 'timestamptz', notNull: true })
    expect(outbox.columns['published_at']).toMatchObject({ type: 'timestamptz' })
  })

  it('creates processed_events with event_id as its primary key', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const processedEvents = table(recorder, 'processed_events')

    expect(processedEvents.columns['event_id']).toMatchObject({ type: 'text', primaryKey: true })
  })
})

describe('timesheet schema migration — timesheet_employee_ref (no cross-schema FK)', () => {
  it('is keyed by employee_id with no references column anywhere', () => {
    const recorder = new FakePgmRecorder()
    loadMigration().up(recorder)
    const ref = table(recorder, 'timesheet_employee_ref')

    expect(ref.columns['employee_id']).toMatchObject({ type: 'uuid', primaryKey: true })
    for (const spec of Object.values(ref.columns)) {
      expect(spec.references).toBeUndefined()
    }
  })
})

describe('timesheet schema migration — no foreign keys leave the schema anywhere in the file', () => {
  it('every `references:` in the source points at schema: \'timesheet\' — never another schema', () => {
    const source = migrationSource()
    const referenceBlocks = source.match(/references:\s*\{[^}]*\}/g) ?? []
    expect(referenceBlocks.length).toBeGreaterThan(0)
    for (const block of referenceBlocks) {
      expect(block).toMatch(/schema:\s*'timesheet'/)
    }
  })
})
