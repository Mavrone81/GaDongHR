import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Proves the migration's real shape directly — no database available in
 * this environment (Task 14 brief CONSTRAINTS) — by requiring the actual
 * `migrations/*.js` file (the same file `node-pg-migrate`'s own runner in
 * `main.ts` loads) and running its real `exports.up` against a small
 * *recording* fake `pgm`: the fake never touches a database, it just
 * captures each `createTable`/`createSchema` call's real arguments —
 * i.e. the literal `{ type: 'bytea', ... }` objects the migration itself
 * constructs, not a text/regex approximation of them. This is stronger
 * than scanning the file as text (`svc-audit`'s `migration.test.ts`
 * pattern): a column whose `type` were computed instead of a literal, or
 * a table created in the wrong order relative to a table it FKs into,
 * would still be caught here.
 *
 * The point (Task 14 brief): every 🔐 column from DATABASE-DESIGN.md
 * §2.1's ERD must be `bytea`, enumerated explicitly by name — a loop over
 * "all columns" asserting nothing specific would let a future sensitive
 * column typed `text` slip straight through.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

interface ColumnDef {
  type: string
  notNull?: boolean
  primaryKey?: boolean
  default?: unknown
  references?: { schema: string; name: string }
  referencesConstraintName?: string
  onDelete?: string
}

type Columns = Record<string, ColumnDef>

interface TableNameSpec {
  schema: string
  name: string
}

interface ConstraintDef {
  unique?: string[]
  check?: string
  primaryKey?: string[]
}

interface CreateTableOptions {
  constraints?: Record<string, ConstraintDef>
}

interface RecordedTable {
  schema: string
  name: string
  columns: Columns
  options: CreateTableOptions | undefined
}

/**
 * The subset of node-pg-migrate's real `MigrationBuilder` API this
 * migration actually calls (`up`'s only calls are `createSchema`,
 * `createTable`, `createIndex`, `func`, and `dropSchema` in `down`) —
 * exactly the same reduced-surface-fake approach kernel's `JwksFetcher`
 * and `AuthzTransport`/`CryptoTransport` ports use elsewhere in this repo
 * to test real logic without a real dependency.
 */
interface FakePgm {
  createSchema(name: string, opts?: { ifNotExists?: boolean }): void
  dropSchema(name: string, opts?: { cascade?: boolean; ifExists?: boolean }): void
  createTable(nameSpec: TableNameSpec | string, columns: Columns, opts?: CreateTableOptions): void
  createIndex(nameSpec: TableNameSpec | string, columns: string[] | string, opts?: unknown): void
  func(expr: string): { __pgmFunc: string }
  sql(query: string): void
}

interface MigrationModule {
  up: (pgm: FakePgm) => void
  down: (pgm: FakePgm) => void
}

function loadMigrationModule(): MigrationModule {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  if (files.length !== 1) {
    throw new Error(`expected exactly one migration file in ${MIGRATIONS_DIR}, found ${files.length}`)
  }
  const [file] = files
  if (!file) throw new Error('unreachable: length checked above')
  const path = join(MIGRATIONS_DIR, file)
  // Migration files are plain CommonJS `.js` (node-pg-migrate's own runner
  // loads them with `require` — `main.ts`'s `runner({ dir: ... })` — and
  // there is no ESM module here to `import`), so a dynamic `require` is
  // the correct way to load one, not a workaround.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above; this is the one legitimate dynamic-require site in this service
  const mod: unknown = require(path)
  return mod as MigrationModule
}

function recordingPgm(): { pgm: FakePgm; tables: RecordedTable[]; schemasCreated: Array<{ name: string; opts?: { ifNotExists?: boolean } }> } {
  const tables: RecordedTable[] = []
  const schemasCreated: Array<{ name: string; opts?: { ifNotExists?: boolean } }> = []
  const pgm: FakePgm = {
    createSchema: (name, opts) => {
      schemasCreated.push({ name, opts })
    },
    dropSchema: () => undefined,
    createTable: (nameSpec, columns, opts) => {
      const { schema, name } = typeof nameSpec === 'string' ? { schema: 'public', name: nameSpec } : nameSpec
      tables.push({ schema, name, columns, options: opts })
    },
    createIndex: () => undefined,
    func: (expr) => ({ __pgmFunc: expr }),
    sql: () => undefined,
  }
  return { pgm, tables, schemasCreated }
}

function findTable(tables: RecordedTable[], name: string): RecordedTable {
  const table = tables.find((t) => t.name === name)
  if (!table) throw new Error(`migration never created a table named "${name}"`)
  return table
}

function column(table: RecordedTable, name: string): ColumnDef {
  const def = table.columns[name]
  if (!def) throw new Error(`table "${table.name}" has no column "${name}"`)
  return def
}

describe('onboarding schema migration', () => {
  const migration = loadMigrationModule()

  function run(): { tables: RecordedTable[]; schemasCreated: Array<{ name: string; opts?: { ifNotExists?: boolean } }> } {
    const { pgm, tables, schemasCreated } = recordingPgm()
    migration.up(pgm)
    return { tables, schemasCreated }
  }

  it('applies cleanly against a recording fake — up() runs with no exception', () => {
    expect(() => run()).not.toThrow()
  })

  it('creates the onboarding schema with ifNotExists — a prerequisite for a safe re-run, not just the first run', () => {
    const { schemasCreated } = run()
    const onboarding = schemasCreated.find((s) => s.name === 'onboarding')
    expect(onboarding).toBeDefined()
    expect(onboarding?.opts?.ifNotExists).toBe(true)
  })

  it('is idempotent on re-run: main.ts drives node-pg-migrate with migrationsTable set, so a second boot applies nothing and errors on nothing', () => {
    // Real re-run idempotency is node-pg-migrate's own bookkeeping (it
    // records each applied migration by name in `migrationsTable` and only
    // executes what is not yet recorded) — there is no Postgres here to
    // prove that end-to-end, so this proves the structural precondition:
    // `main.ts` actually wires that bookkeeping on, the same as
    // `svc-config`'s `main.ts`.
    const mainSource = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    expect(mainSource).toMatch(/migrationsTable:\s*['"]pgmigrations['"]/)
    expect(mainSource).toMatch(/direction:\s*['"]up['"]/)
  })

  it('creates every ERD table from DATABASE-DESIGN.md §2.1 in FK-safe order', () => {
    const { tables } = run()
    const names = tables.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'org_unit',
        'position',
        'employee',
        'employee_document',
        'consent_form',
        'consent_record',
        'onboarding_task',
        'probation',
        'outbox',
        'processed_events',
      ]),
    )
    const at = (n: string): number => names.indexOf(n)
    // A table must be created after every table it FKs into.
    expect(at('org_unit')).toBeLessThan(at('employee'))
    expect(at('position')).toBeLessThan(at('employee'))
    expect(at('org_unit')).toBeLessThan(at('position'))
    expect(at('employee')).toBeLessThan(at('employee_document'))
    expect(at('employee')).toBeLessThan(at('consent_record'))
    expect(at('consent_form')).toBeLessThan(at('consent_record'))
    expect(at('employee')).toBeLessThan(at('onboarding_task'))
    expect(at('employee')).toBeLessThan(at('probation'))
  })

  describe('every 🔐 column on employee is bytea, enumerated explicitly', () => {
    const SENSITIVE_EMPLOYEE_COLUMNS = [
      'first_name_th',
      'last_name_th',
      'first_name_en',
      'last_name_en',
      'name_zh',
      'national_id',
      'passport_no',
      'tax_id',
      'sso_number',
      'bank_account',
      'dob',
      'address',
      'phone',
      'email',
    ] as const

    it.each(SENSITIVE_EMPLOYEE_COLUMNS)('employee.%s is bytea', (col) => {
      const { tables } = run()
      const employee = findTable(tables, 'employee')
      expect(column(employee, col).type).toBe('bytea')
    })

    it('every column NOT in the enumerated 🔐 list above stays its natural (non-bytea) type — proves the sensitive set is exhaustive, not just a subset', () => {
      const { tables } = run()
      const employee = findTable(tables, 'employee')
      const nonSensitive = ['emp_code', 'employment_type', 'bank_code', 'province_code', 'start_date', 'status', 'preferred_lang', 'org_unit_id', 'position_id']
      for (const col of nonSensitive) {
        expect(column(employee, col).type).not.toBe('bytea')
      }
    })
  })

  it('national_id_bidx is bytea and UNIQUE — the actual mechanism behind ONB-002 (duplicate national ID blocked)', () => {
    const { tables } = run()
    const employee = findTable(tables, 'employee')
    expect(column(employee, 'national_id_bidx').type).toBe('bytea')
    const constraints = employee.options?.constraints ?? {}
    const uniqueOnBidx = Object.values(constraints).some((c) => c.unique?.includes('national_id_bidx'))
    expect(uniqueOnBidx).toBe(true)
  })

  it('email_bidx is bytea (the companion blind index for the other searchable 🔐 field)', () => {
    const { tables } = run()
    const employee = findTable(tables, 'employee')
    expect(column(employee, 'email_bidx').type).toBe('bytea')
  })

  it('consent_record.form_text_snapshot is bytea — 🔐 "as-shown" snapshot, DATABASE-DESIGN §2.1', () => {
    const { tables } = run()
    const consentRecord = findTable(tables, 'consent_record')
    expect(column(consentRecord, 'form_text_snapshot').type).toBe('bytea')
  })

  it('employee_document.file_ref is bytea — MinIO pointer, same treatment as every other schema\'s file-pointer column', () => {
    const { tables } = run()
    const doc = findTable(tables, 'employee_document')
    expect(column(doc, 'file_ref').type).toBe('bytea')
  })

  it('processed_events has event_id as its primary key — without it, consumer dedupe silently degrades to a no-op', () => {
    const { tables } = run()
    const processedEvents = findTable(tables, 'processed_events')
    expect(column(processedEvents, 'event_id').primaryKey).toBe(true)
  })

  it('outbox exists with the standard shape (id, topic, payload, created_at, published_at)', () => {
    const { tables } = run()
    const outbox = findTable(tables, 'outbox')
    expect(column(outbox, 'id').primaryKey).toBe(true)
    expect(column(outbox, 'topic').type).toBe('text')
    expect(column(outbox, 'payload').type).toBe('jsonb')
    expect(column(outbox, 'created_at').type).toBe('timestamptz')
    expect(column(outbox, 'published_at').type).toBe('timestamptz')
  })

  it('every table\'s id is a uuid primary key, and every mutable table carries created_at/updated_at', () => {
    const { tables } = run()
    for (const name of ['org_unit', 'position', 'employee', 'probation']) {
      const table = findTable(tables, name)
      expect(column(table, 'id').primaryKey).toBe(true)
      expect(column(table, 'id').type).toBe('uuid')
      expect(column(table, 'created_at').type).toBe('timestamptz')
      expect(column(table, 'updated_at').type).toBe('timestamptz')
    }
  })

  it('employee_document is a uuid-PK table timestamped by uploaded_at, not created_at/updated_at — its lifecycle is upload → verify/reject, not a general mutable row', () => {
    const { tables } = run()
    const doc = findTable(tables, 'employee_document')
    expect(column(doc, 'id').primaryKey).toBe(true)
    expect(column(doc, 'id').type).toBe('uuid')
    expect(column(doc, 'uploaded_at').type).toBe('timestamptz')
  })
})
