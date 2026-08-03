import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Proves the migration's SQL shape directly — no database available in
 * this environment (Task 14 brief CONSTRAINTS, matching Tasks 7/8/9/14's
 * precedent). Three assertion strategies:
 *
 *  1. Regex assertions against the migration file's own source text
 *     (`migrationSource()`), the same technique
 *     `services/svc-attendance/src/attendance-schema.test.ts` established —
 *     used only for column-shape assertions, never for constraint
 *     existence (see 3).
 *  2. A structural run of `exports.up` against a minimal fake
 *     `MigrationBuilder` (`FakePgm`) that records every builder call it
 *     receives — proves the migration function is a deterministic,
 *     side-effect-free sequence of builder calls (the property that makes
 *     re-running it safe; real re-run idempotency for an *already applied*
 *     migration is `node-pg-migrate`'s job via its `pgmigrations` ledger,
 *     which `src/main.ts` wires exactly as `services/svc-config` does).
 *  3. (Task 16c) Constraint-existence assertions run the migration against
 *     node-pg-migrate's REAL `MigrationBuilderImpl` — the same class
 *     `Migration.apply()` constructs internally — and inspect the actual
 *     generated SQL. `payroll_run_sod_check` used to be asserted by a
 *     source-text regex, which cannot tell the difference between
 *     node-pg-migrate's valid `constraints: { check: ... }` shape and the
 *     invalid `constraints: { payroll_run_sod_check: { check: ... } } }`
 *     shape this migration actually used (Task 16c) — both "look like" a
 *     constraint to a text scanner, but only the former is ever created.
 *
 * The two most important suites here are the ones proving the schema's two
 * legal controls: segregation of duties (`payroll_run_sod_check`) and
 * committed-run immutability (the two `BEFORE UPDATE OR DELETE` triggers,
 * raw SQL via `pgm.sql(...)` and never affected by the constraints bug).
 * Both are demonstrated failing when their source is removed — the brief's
 * "demonstrate it fails when removed".
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migrationFiles(): string[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  if (files.length === 0) throw new Error(`no migration files found in ${MIGRATIONS_DIR}`)
  return files
}

function migrationSource(): string {
  return migrationFiles()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n')
}

interface PayrollMigrationModule {
  up: (pgm: FakePgm) => void
  down: (pgm: FakePgm) => void
}

function loadMigration(): PayrollMigrationModule {
  const files = migrationFiles()
  const payrollSchemaFile = files.find((f) => f.includes('payroll-schema'))
  if (payrollSchemaFile === undefined) throw new Error('no *payroll-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, payrollSchemaFile)) as PayrollMigrationModule
}

function loadRealMigration(): { up: (pgm: MigrationBuilder) => void; down: (pgm: MigrationBuilder) => void } {
  const files = migrationFiles()
  const payrollSchemaFile = files.find((f) => f.includes('payroll-schema'))
  if (payrollSchemaFile === undefined) throw new Error('no *payroll-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, payrollSchemaFile)) as {
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

/** Runs `action` against a real node-pg-migrate `MigrationBuilder` and returns the exact SQL it would emit — see file header, strategy 3. */
function buildSql(action: (pgm: MigrationBuilder) => void): string {
  const pgm = new MigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
  action(pgm)
  return pgm.getSql()
}

/** Every builder call `exports.up`/`exports.down` in this migration actually issues, recorded in call order. */
type RecordedCall = { method: string; args: unknown[] }

/**
 * A minimal stand-in for node-pg-migrate's `MigrationBuilder`, covering
 * exactly the methods this migration calls (`createSchema`, `createTable`,
 * `createIndex`, `sql`, `dropSchema`, `func`) — the same set
 * `attendance-schema.test.ts`'s `FakePgm` covers, since this migration uses
 * the identical builder surface (plus raw `sql()` for the two immutability
 * triggers, already covered).
 */
class FakePgm {
  readonly calls: RecordedCall[] = []

  createSchema(...args: unknown[]): void {
    this.calls.push({ method: 'createSchema', args })
  }

  createTable(...args: unknown[]): void {
    this.calls.push({ method: 'createTable', args })
  }

  createIndex(...args: unknown[]): void {
    this.calls.push({ method: 'createIndex', args })
  }

  sql(...args: unknown[]): void {
    this.calls.push({ method: 'sql', args })
  }

  dropSchema(...args: unknown[]): void {
    this.calls.push({ method: 'dropSchema', args })
  }

  addConstraint(...args: unknown[]): void {
    this.calls.push({ method: 'addConstraint', args })
  }

  /** node-pg-migrate's `pgm.func(expr)` wraps a raw SQL expression (e.g. `now()`) so it isn't quoted as a string literal default — here it's just an identity tag, sufficient for structural comparison. */
  func(expr: string): { __rawSqlFunc: string } {
    return { __rawSqlFunc: expr }
  }
}

describe('payroll schema migration — applies cleanly and deterministically', () => {
  it('exports.up runs against a fake MigrationBuilder without throwing', () => {
    const migration = loadMigration()
    const pgm = new FakePgm()
    expect(() => migration.up(pgm)).not.toThrow()
    expect(pgm.calls.length).toBeGreaterThan(0)
  })

  it('exports.down runs against a fake MigrationBuilder without throwing', () => {
    const migration = loadMigration()
    const pgm = new FakePgm()
    expect(() => migration.down(pgm)).not.toThrow()
  })

  it('is idempotent at the JS level: two independent runs of exports.up issue the exact same sequence of builder calls', () => {
    const migration = loadMigration()
    const pgm1 = new FakePgm()
    const pgm2 = new FakePgm()
    migration.up(pgm1)
    migration.up(pgm2)
    expect(pgm2.calls).toEqual(pgm1.calls)
  })

  it('creates the schema with ifNotExists: true — re-running against a database where it already exists does not error', () => {
    const migration = loadMigration()
    const pgm = new FakePgm()
    migration.up(pgm)
    const createSchemaCall = pgm.calls.find((c) => c.method === 'createSchema')
    expect(createSchemaCall).toBeDefined()
    expect(createSchemaCall?.args).toEqual(['payroll', { ifNotExists: true }])
  })

  it('down drops the schema with ifExists: true, mirroring the up side (and cascades onto the trigger functions)', () => {
    const migration = loadMigration()
    const pgm = new FakePgm()
    migration.down(pgm)
    const dropSchemaCall = pgm.calls.find((c) => c.method === 'dropSchema')
    expect(dropSchemaCall).toBeDefined()
    expect(dropSchemaCall?.args).toEqual(['payroll', { cascade: true, ifExists: true }])
  })
})

describe('payroll schema migration — every money column is bytea, enumerated explicitly', () => {
  it('the exact set of 🔐 columns across pay_profile, payslip, pay_item and statutory_export is bytea — nothing more, nothing less', () => {
    const source = migrationSource()
    // Matches `<column_name>: { type: 'bytea', ... }` — the exact shape
    // every column definition in this codebase's migrations uses.
    const byteaColumnPattern = /(\w+):\s*\{\s*type:\s*'bytea'/g
    const byteaColumns: string[] = []
    let match: RegExpExecArray | null
    while ((match = byteaColumnPattern.exec(source)) !== null) {
      const columnName = match[1]
      if (columnName !== undefined) byteaColumns.push(columnName)
    }
    // Explicit enumeration, not just a length check — this is the test
    // that keeps a salary, bank account, tax figure or payslip amount out
    // of the database in plaintext (Task 14 brief: "A salary in plaintext
    // defeats the product's central claim"). The 12 named in the brief
    // (base_pay, pf_rate, tax_allowance_decl / gross, sso_emp, ewf_emp,
    // pf_emp, tax_wht, net, ytd, pdf_ref / file_ref) plus `pay_item.amount`
    // — the one money column this task's migration adds beyond the brief's
    // literal list, and documented as such in the migration's file header.
    expect(byteaColumns).toEqual([
      'base_pay',
      'pf_rate',
      'tax_allowance_decl',
      'gross',
      'sso_emp',
      'ewf_emp',
      'pf_emp',
      'tax_wht',
      'net',
      'ytd',
      'pdf_ref',
      'amount',
      'file_ref',
    ])
  })

  it('every column named in the Task 14 brief is present and bytea, checked individually', () => {
    const source = migrationSource()
    const moneyColumns = [
      'base_pay',
      'pf_rate',
      'tax_allowance_decl',
      'gross',
      'sso_emp',
      'ewf_emp',
      'pf_emp',
      'tax_wht',
      'net',
      'ytd',
      'pdf_ref',
      'file_ref',
    ]
    for (const column of moneyColumns) {
      const columnMatch = new RegExp(`\\b${column}:\\s*\\{[^}]*\\}`).exec(source)
      expect(columnMatch).not.toBeNull()
      expect(columnMatch?.[0]).toMatch(/type:\s*'bytea'/)
    }
  })

  it('DEMONSTRATION: the exhaustive enumeration FAILS if a money column is (re)written as plaintext text instead of bytea', () => {
    const source = migrationSource()
    // Simulates the exact regression this suite exists to catch: `base_pay`
    // silently downgraded from `bytea` (ciphertext) to `text` (plaintext) —
    // e.g. a careless refactor. The column still exists and still has a
    // name that looks right; only its type changed.
    const withMoneyColumnLeaked = source.replace(
      "base_pay: { type: 'bytea', notNull: true },",
      "base_pay: { type: 'text', notNull: true },",
    )
    expect(withMoneyColumnLeaked).not.toEqual(source)

    const byteaColumnPattern = /(\w+):\s*\{\s*type:\s*'bytea'/g
    const byteaColumns: string[] = []
    let match: RegExpExecArray | null
    while ((match = byteaColumnPattern.exec(withMoneyColumnLeaked)) !== null) {
      const columnName = match[1]
      if (columnName !== undefined) byteaColumns.push(columnName)
    }
    // `base_pay` drops out of the bytea enumeration entirely — the fixed
    // 13-item list this suite asserts above no longer matches, which is
    // exactly the CI failure a plaintext-salary regression must produce.
    expect(byteaColumns).not.toContain('base_pay')
    expect(byteaColumns).not.toEqual([
      'base_pay',
      'pf_rate',
      'tax_allowance_decl',
      'gross',
      'sso_emp',
      'ewf_emp',
      'pf_emp',
      'tax_wht',
      'net',
      'ytd',
      'pdf_ref',
      'amount',
      'file_ref',
    ])
  })
})

describe('payroll schema migration — segregation of duties (payroll_run_sod_check)', () => {
  /**
   * Task 16c: this used to be a source-text regex against
   * `payroll_run_sod_check:\s*\{\s*check:...` — the exact
   * `{ constraints: { payroll_run_sod_check: { check: ... } } }` shape
   * node-pg-migrate's `parseConstraints` silently ignores (the name is
   * nested one level inside `options.constraints` instead of being a
   * recognised kind), so the old regex passed while the constraint itself
   * never existed. This now runs the migration through node-pg-migrate's
   * REAL `MigrationBuilderImpl` and inspects the actual generated SQL.
   */
  it('the CHECK constraint exists, matching the Task 14 brief verbatim, actually created by node-pg-migrate', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "payroll_run_sod_check" CHECK \(approved_by IS NULL OR approved_by <> prepared_by\);/,
    )
  })

  it('prepared_by is notNull — required so the check is never vacuously true', () => {
    const source = migrationSource()
    const columnMatch = /prepared_by:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'uuid'/)
    expect(columnMatch?.[0]).toMatch(/notNull:\s*true/)
  })

  it('approved_by is nullable (no notNull) — unset until a different user approves', () => {
    const source = migrationSource()
    const columnMatch = /approved_by:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'uuid'/)
    expect(columnMatch?.[0]).not.toMatch(/notNull:\s*true/)
  })

  /**
   * Regression proof, kept executable rather than a one-off manual run:
   * reconstructs the exact broken options object this constraint used to
   * be declared with before Task 16c's fix, and proves node-pg-migrate's
   * real `parseConstraints` produces no CHECK constraint from it at all —
   * this is the "fails against the old shape" demonstration the Task 16c
   * brief asks for.
   */
  it('the OLD { constraints: { payroll_run_sod_check: { check: ... } } } shape produces no CHECK constraint', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'payroll', name: 'payroll_run_regression_check' },
        { prepared_by: { type: 'uuid', notNull: true }, approved_by: { type: 'uuid' } },
        {
          constraints: {
            payroll_run_sod_check: { check: 'approved_by IS NULL OR approved_by <> prepared_by' },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used.
        } as any,
      )
    })
    expect(sql).not.toMatch(/CHECK/)
    expect(sql).not.toMatch(/payroll_run_sod_check/)
  })
})

describe('payroll schema migration — immutability of committed runs', () => {
  it('a BEFORE UPDATE OR DELETE trigger exists on payroll_run, executing a function that raises when status is committed', () => {
    const source = migrationSource()
    expect(source).toMatch(
      /CREATE FUNCTION payroll\.forbid_committed_run_mutation\(\)[\s\S]*?OLD\.status = 'committed'[\s\S]*?RAISE EXCEPTION/,
    )
    expect(source).toMatch(
      /CREATE TRIGGER payroll_run_immutable_when_committed\s+BEFORE UPDATE OR DELETE ON payroll\.payroll_run/,
    )
  })

  it('a BEFORE UPDATE OR DELETE trigger exists on payslip, executing a function that raises when its parent run is committed', () => {
    const source = migrationSource()
    expect(source).toMatch(
      /CREATE FUNCTION payroll\.forbid_committed_run_child_mutation\(\)[\s\S]*?run_status = 'committed'[\s\S]*?RAISE EXCEPTION/,
    )
    expect(source).toMatch(
      /CREATE TRIGGER payslip_immutable_when_run_committed\s+BEFORE UPDATE OR DELETE ON payroll\.payslip/,
    )
  })

  it('both triggers fire on UPDATE and DELETE, not just one', () => {
    const source = migrationSource()
    const triggerBlocks = [...source.matchAll(/BEFORE UPDATE OR DELETE ON payroll\.\w+/g)]
    expect(triggerBlocks).toHaveLength(2)
  })

  it('DEMONSTRATION: the payroll_run trigger assertion FAILS if its CREATE TRIGGER statement is removed from the source', () => {
    const source = migrationSource()
    const withTriggerRemoved = source.replace(
      /CREATE TRIGGER payroll_run_immutable_when_committed\s+BEFORE UPDATE OR DELETE ON payroll\.payroll_run[\s\S]*?EXECUTE FUNCTION payroll\.forbid_committed_run_mutation\(\);\s*`\)/,
      '`)',
    )
    expect(withTriggerRemoved).not.toEqual(source)
    expect(withTriggerRemoved).not.toMatch(
      /CREATE TRIGGER payroll_run_immutable_when_committed\s+BEFORE UPDATE OR DELETE ON payroll\.payroll_run/,
    )
  })

  it('DEMONSTRATION: the payslip trigger assertion FAILS if its CREATE TRIGGER statement is removed from the source', () => {
    const source = migrationSource()
    const withTriggerRemoved = source.replace(
      /CREATE TRIGGER payslip_immutable_when_run_committed\s+BEFORE UPDATE OR DELETE ON payroll\.payslip[\s\S]*?EXECUTE FUNCTION payroll\.forbid_committed_run_child_mutation\(\);\s*`\)/,
      '`)',
    )
    expect(withTriggerRemoved).not.toEqual(source)
    expect(withTriggerRemoved).not.toMatch(
      /CREATE TRIGGER payslip_immutable_when_run_committed\s+BEFORE UPDATE OR DELETE ON payroll\.payslip/,
    )
  })

  it('corrections happen through a new adjustment run — run_type allows it', () => {
    const source = migrationSource()
    expect(source).toMatch(/run_type IN \('regular', 'offcycle', 'adjustment', 'final_pay'\)/)
  })
})

describe('payroll schema migration — timesheet_lock_version binds a run to its exact hours', () => {
  it('is declared integer and notNull', () => {
    const source = migrationSource()
    const columnMatch = /timesheet_lock_version:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'integer'/)
    expect(columnMatch?.[0]).toMatch(/notNull:\s*true/)
  })
})

describe('payroll schema migration — no foreign key crosses a schema boundary', () => {
  it('every `references: { schema: ... }` block in this file points at the payroll schema itself', () => {
    const source = migrationSource()
    const referenceBlocks = [...source.matchAll(/references:\s*\{\s*schema:\s*'(\w+)'/g)]
    // At least the payslip->payroll_run, pay_item->payslip and
    // statutory_export->payroll_run in-schema FKs must be present.
    expect(referenceBlocks.length).toBeGreaterThan(0)
    for (const block of referenceBlocks) {
      expect(block[1]).toBe('payroll')
    }
  })

  it('employee_id columns on pay_profile, payslip and payroll_employee_ref carry no `references` at all', () => {
    const source = migrationSource()
    for (const table of ['pay_profile', 'payslip']) {
      const tableBlock = new RegExp(`name:\\s*['"]${table}['"][\\s\\S]{0,1200}`).exec(source)?.[0] ?? ''
      const employeeIdField = /employee_id:\s*\{[^}]*\}/.exec(tableBlock)
      expect(employeeIdField).not.toBeNull()
      expect(employeeIdField?.[0]).not.toMatch(/references:/)
    }
  })

  it('payroll_employee_ref exists and has no FK/references to another schema', () => {
    const source = migrationSource()
    expect(source).toMatch(/name:\s*['"]payroll_employee_ref['"]/)
    const block = /name:\s*['"]payroll_employee_ref['"][\s\S]{0,400}/.exec(source)?.[0] ?? ''
    expect(block).not.toMatch(/references:/)
  })
})

describe('payroll schema migration — processed_events / outbox (standard shape)', () => {
  it('processed_events has event_id as its primary key', () => {
    const source = migrationSource()
    expect(source).toMatch(/name:\s*['"]processed_events['"][\s\S]{0,300}event_id[\s\S]{0,100}primaryKey:\s*true/)
  })

  it('outbox exists with the standard id/topic/payload/created_at/published_at shape', () => {
    const source = migrationSource()
    const outboxBlockMatch = /name:\s*['"]outbox['"][\s\S]{0,600}/.exec(source)
    expect(outboxBlockMatch).not.toBeNull()
    const block = outboxBlockMatch?.[0] ?? ''
    for (const column of ['id', 'topic', 'payload', 'created_at', 'published_at']) {
      expect(block).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })
})

describe('payroll schema migration — every DATABASE-DESIGN.md §2.5 column is present', () => {
  it('pay_profile has every specified column', () => {
    const source = migrationSource()
    for (const column of [
      'id',
      'employee_id',
      'base_pay',
      'pay_basis',
      'recurring_items',
      'pf_rate',
      'tax_allowance_decl',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('payroll_run has every specified column', () => {
    const source = migrationSource()
    for (const column of [
      'id',
      'period',
      'run_type',
      'timesheet_lock_version',
      'status',
      'prepared_by',
      'approved_by',
      'rulepack_versions',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('payslip has every specified column', () => {
    const source = migrationSource()
    for (const column of [
      'run_id',
      'employee_id',
      'gross',
      'sso_emp',
      'ewf_emp',
      'pf_emp',
      'tax_wht',
      'net',
      'ytd',
      'pdf_ref',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('statutory_export has every specified column', () => {
    const source = migrationSource()
    for (const column of ['run_id', 'kind', 'file_ref', 'status']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })
})

describe('payroll schema migration — every remaining constraint is actually created by node-pg-migrate (Task 16c)', () => {
  it('pay_profile_employee_id_key, pay_profile_pay_basis_check', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "pay_profile_employee_id_key" UNIQUE \("employee_id"\);/)
    expect(sql).toMatch(
      /ADD CONSTRAINT "pay_profile_pay_basis_check" CHECK \(pay_basis IN \('monthly', 'daily', 'hourly'\)\);/,
    )
  })

  it('payroll_run_run_type_check, payroll_run_status_check, payroll_run_timesheet_lock_version_check', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "payroll_run_run_type_check" CHECK \(run_type IN \('regular', 'offcycle', 'adjustment', 'final_pay'\)\);/,
    )
    expect(sql).toMatch(
      /ADD CONSTRAINT "payroll_run_status_check" CHECK \(status IN \('draft', 'calculated', 'reviewed', 'approved', 'committed'\)\);/,
    )
    expect(sql).toMatch(
      /ADD CONSTRAINT "payroll_run_timesheet_lock_version_check" CHECK \(timesheet_lock_version >= 0\);/,
    )
  })

  it('statutory_export_kind_check, statutory_export_status_check', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "statutory_export_kind_check" CHECK \(kind IN \('sso_1_10', 'pnd1', 'bank_csv', 'pnd1kor', '50bis', 'kor_ror_11'\)\);/,
    )
    expect(sql).toMatch(
      /ADD CONSTRAINT "statutory_export_status_check" CHECK \(status IN \('generated', 'downloaded'\)\);/,
    )
  })
})
