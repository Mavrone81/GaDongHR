import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import RealMigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

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
 * (Task 16c) A `pgm.addConstraint(table, constraintName, spec)` call — the
 * migration's fix for node-pg-migrate silently ignoring a name-keyed
 * `constraints:` option passed to `createTable` itself. Recorded separately
 * from `RecordedTable.options.constraints` (which node-pg-migrate's
 * `createTable` no longer receives at all post-fix) so tests can assert a
 * constraint was actually declared the way the migration now declares it.
 */
interface RecordedConstraint {
  schema: string
  name: string
  constraintName: string
  spec: ConstraintDef
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
  addConstraint(nameSpec: TableNameSpec | string, constraintName: string, spec: ConstraintDef): void
  dropConstraint(nameSpec: TableNameSpec | string, constraintName: string, opts?: { ifExists?: boolean }): void
  addColumn(nameSpec: TableNameSpec | string, columns: Columns): void
  dropColumn(nameSpec: TableNameSpec | string, columnName: string): void
  func(expr: string): { __pgmFunc: string }
  sql(query: string): void
}

interface MigrationModule {
  up: (pgm: FakePgm) => void
  down: (pgm: FakePgm) => void
}

/**
 * `svc-onboarding` shipped with exactly one migration until this task
 * (Task 14 brief: schema-only). This task's own migration
 * (`..._employee-clock-in-method.js`, M1-3's `clock_in_method` routing
 * column — see its own header for why it exists and is not an adverse
 * flag) is deliberately additive rather than folded into the original
 * file, so every migration in `migrations/` is loaded and applied **in
 * filename order** — the same order `node-pg-migrate`'s real runner
 * (`main.ts`) applies them in.
 */
function loadMigrationModules(): MigrationModule[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
  if (files.length === 0) {
    throw new Error(`expected at least one migration file in ${MIGRATIONS_DIR}, found none`)
  }
  return files.map((file) => {
    const path = join(MIGRATIONS_DIR, file)
    // Migration files are plain CommonJS `.js` (node-pg-migrate's own
    // runner loads them with `require` — `main.ts`'s `runner({ dir: ... })`
    // — and there is no ESM module here to `import`), so a dynamic
    // `require` is the correct way to load one, not a workaround.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above; this is the one legitimate dynamic-require site in this service
    const mod: unknown = require(path)
    return mod as MigrationModule
  })
}

function combinedUp(pgm: FakePgm): void {
  for (const mod of loadMigrationModules()) mod.up(pgm)
}

function recordingPgm(): {
  pgm: FakePgm
  tables: RecordedTable[]
  schemasCreated: Array<{ name: string; opts?: { ifNotExists?: boolean } }>
  constraints: RecordedConstraint[]
} {
  const tables: RecordedTable[] = []
  const schemasCreated: Array<{ name: string; opts?: { ifNotExists?: boolean } }> = []
  const constraints: RecordedConstraint[] = []
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
    addConstraint: (nameSpec, constraintName, spec) => {
      const { schema, name } = typeof nameSpec === 'string' ? { schema: 'public', name: nameSpec } : nameSpec
      constraints.push({ schema, name, constraintName, spec })
    },
    dropConstraint: () => undefined,
    addColumn: (nameSpec, columns) => {
      const { schema, name } = typeof nameSpec === 'string' ? { schema: 'public', name: nameSpec } : nameSpec
      const table = tables.find((t) => t.schema === schema && t.name === name)
      if (!table) throw new Error(`addColumn: recordingPgm has no table "${name}" — createTable must run first`)
      Object.assign(table.columns, columns)
    },
    dropColumn: () => undefined,
    func: (expr) => ({ __pgmFunc: expr }),
    sql: () => undefined,
  }
  return { pgm, tables, schemasCreated, constraints }
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
  function run(): {
    tables: RecordedTable[]
    schemasCreated: Array<{ name: string; opts?: { ifNotExists?: boolean } }>
    constraints: RecordedConstraint[]
  } {
    const { pgm, tables, schemasCreated, constraints } = recordingPgm()
    combinedUp(pgm)
    return { tables, schemasCreated, constraints }
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

  /**
   * Task 16c: this used to read `employee.options?.constraints` directly —
   * the raw `createTable` options object — and scan `Object.values()` for
   * one whose `.unique` array includes `national_id_bidx`. That check
   * would have PASSED even against the original bug: the migration used to
   * declare `{ constraints: { employee_national_id_bidx_key: { unique: [...] } } }`,
   * and `Object.values()` finds the `{ unique: [...] }` value regardless of
   * what key it's nested under — even though node-pg-migrate's own
   * `parseConstraints` only recognises `unique` as a TOP-LEVEL key of
   * `constraints`, not nested one level deeper. The fix moves this
   * constraint out of `createTable`'s options entirely into a
   * `pgm.addConstraint` call, which this test now checks directly.
   */
  it('national_id_bidx is bytea and UNIQUE — the actual mechanism behind ONB-002 (duplicate national ID blocked)', () => {
    const { tables, constraints } = run()
    const employee = findTable(tables, 'employee')
    expect(column(employee, 'national_id_bidx').type).toBe('bytea')
    const uniqueOnBidx = constraints.some(
      (c) => c.name === 'employee' && c.constraintName === 'employee_national_id_bidx_key' && c.spec.unique?.includes('national_id_bidx'),
    )
    expect(uniqueOnBidx).toBe(true)
  })

  it("employee.clock_in_method is text, defaults to 'biometric', and is not bytea — a routing fact, not a 🔐 field, and not encrypted", () => {
    const { tables } = run()
    const employee = findTable(tables, 'employee')
    expect(column(employee, 'clock_in_method').type).toBe('text')
    expect(column(employee, 'clock_in_method').default).toBe('biometric')
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

describe('onboarding schema migration — every remaining constraint is actually created by node-pg-migrate (Task 16c)', () => {
  /**
   * Goes one step further than the recording `FakePgm` above: runs the
   * migration through node-pg-migrate's REAL `MigrationBuilderImpl` (the
   * same class `Migration.apply()` constructs internally) and confirms the
   * `addConstraint` calls actually produce the SQL Postgres would run.
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

  function buildRealSql(): string {
    const pgm = new RealMigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
    for (const migration of loadMigrationModules()) {
      ;(migration.up as unknown as (pgm: MigrationBuilder) => void)(pgm)
    }
    return pgm.getSql()
  }

  it('position_code_key: UNIQUE (code)', () => {
    const sql = buildRealSql()
    expect(sql).toMatch(/ADD CONSTRAINT "position_code_key" UNIQUE \("code"\);/)
  })

  it('employee_emp_code_key, employee_employment_type_check, employee_status_check, employee_preferred_lang_check', () => {
    const sql = buildRealSql()
    expect(sql).toMatch(/ADD CONSTRAINT "employee_emp_code_key" UNIQUE \("emp_code"\);/)
    expect(sql).toMatch(
      /ADD CONSTRAINT "employee_employment_type_check" CHECK \(employment_type IN \('monthly', 'daily', 'hourly', 'contract'\)\);/,
    )
    expect(sql).toMatch(
      /ADD CONSTRAINT "employee_status_check" CHECK \(status IN \('draft', 'onboarding', 'active', 'cancelled', 'terminated'\)\);/,
    )
    expect(sql).toMatch(
      /ADD CONSTRAINT "employee_preferred_lang_check" CHECK \(preferred_lang IN \('th', 'en', 'zh'\)\);/,
    )
  })

  it('employee_document_status_check', () => {
    const sql = buildRealSql()
    expect(sql).toMatch(
      /ADD CONSTRAINT "employee_document_status_check" CHECK \(status IN \('pending', 'verified', 'rejected'\)\);/,
    )
  })

  it('consent_form_purpose_lang_version_key, consent_form_lang_check', () => {
    const sql = buildRealSql()
    expect(sql).toMatch(
      /ADD CONSTRAINT "consent_form_purpose_lang_version_key" UNIQUE \("purpose", "lang", "version"\);/,
    )
    expect(sql).toMatch(/ADD CONSTRAINT "consent_form_lang_check" CHECK \(lang IN \('th', 'en', 'zh'\)\);/)
  })

  it('consent_record_state_check', () => {
    const sql = buildRealSql()
    expect(sql).toMatch(
      /ADD CONSTRAINT "consent_record_state_check" CHECK \(state IN \('granted', 'refused', 'withdrawn'\)\);/,
    )
  })

  it('probation_employee_id_key, probation_outcome_check', () => {
    const sql = buildRealSql()
    expect(sql).toMatch(/ADD CONSTRAINT "probation_employee_id_key" UNIQUE \("employee_id"\);/)
    expect(sql).toMatch(
      /ADD CONSTRAINT "probation_outcome_check" CHECK \(outcome IS NULL OR outcome IN \('confirm', 'extend', 'terminate'\)\);/,
    )
  })

  it("employee_clock_in_method_check — added by this task's migration, and it is NOT an adverse flag (no 'refused'/'denied' vocabulary anywhere in the constraint's own SQL)", () => {
    const sql = buildRealSql()
    const clause = /ADD CONSTRAINT "employee_clock_in_method_check" CHECK \(clock_in_method IN \('biometric', 'alternative'\)\);/.exec(sql)?.[0]
    expect(clause).toBe("ADD CONSTRAINT \"employee_clock_in_method_check\" CHECK (clock_in_method IN ('biometric', 'alternative'));")
    expect(clause).not.toMatch(/refus/i)
    expect(clause).not.toMatch(/denied/i)
    expect(clause).not.toMatch(/adverse/i)
  })

  /**
   * Regression proof, kept executable: reconstructs the exact broken
   * options object every one of onboarding's twelve constraints (Task 16c)
   * used to be declared with, and proves node-pg-migrate's real
   * `parseConstraints` produces nothing from it.
   */
  it('the OLD { constraints: { <name>: { unique/check: ... } } } shape produces no constraint at all', () => {
    const pgm = new RealMigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
    pgm.createTable(
      { schema: 'onboarding', name: 'position_regression_check' },
      { code: { type: 'text', notNull: true } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used.
      { constraints: { position_code_key: { unique: ['code'] } } } as any,
    )
    const sql = pgm.getSql()
    expect(sql).not.toMatch(/UNIQUE/)
    expect(sql).not.toMatch(/position_code_key/)
  })
})
