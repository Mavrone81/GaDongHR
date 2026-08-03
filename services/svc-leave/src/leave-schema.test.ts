import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Proves the migration's SQL shape directly — no database available in
 * this environment (Task 14 brief CONSTRAINTS, matching Tasks 7/8/9/13's
 * precedent). Three assertion strategies are used:
 *
 *  1. Regex assertions against the migration file's own source text
 *     (`migrationSource()`), the same technique
 *     `services/svc-attendance/src/attendance-schema.test.ts` established —
 *     used only for column-shape assertions, never for constraint
 *     existence (see 3).
 *  2. A structural run of `exports.up` against a minimal fake
 *     `MigrationBuilder` (`FakePgm`) that records every builder call it
 *     receives — this proves the migration function is a deterministic,
 *     side-effect-free sequence of builder calls (the property that makes
 *     re-running it safe; real re-run idempotency for an *already applied*
 *     migration is `node-pg-migrate`'s job via its `pgmigrations` ledger,
 *     which `src/main.ts` wires exactly as `services/svc-config` does).
 *  3. (Task 16c) Constraint-existence assertions run the migration against
 *     node-pg-migrate's REAL `MigrationBuilderImpl` — the same class
 *     `Migration.apply()` constructs internally — and inspect the actual
 *     generated SQL. This file previously had NO test at all for
 *     `leave_type_code_key`, `leave_balance_employee_type_year_key`,
 *     `leave_request_status_check`, or `approval_step_decision_check` — all
 *     four were declared via node-pg-migrate's silently-ignored
 *     `{ constraints: { <name>: {...} } }` shape (Task 16c) and so never
 *     actually existed. This closes that gap.
 *
 * The three most important suites here are the ones the Task 14 brief
 * calls out by name: `attachment_ref` is `bytea` (a medical-certificate
 * pointer is health data, PDPA s.26), every balance/day column is
 * `numeric` (a rounding error here is a payroll error — unused annual
 * leave becomes a cash payout on termination), and `statutory_rule_key`
 * is nullable on purpose (company-defined leave types have no statutory
 * floor).
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

interface LeaveMigrationModule {
  up: (pgm: FakePgm) => void
  down: (pgm: FakePgm) => void
}

function loadMigration(): LeaveMigrationModule {
  const files = migrationFiles()
  const leaveSchemaFile = files.find((f) => f.includes('leave-schema'))
  if (leaveSchemaFile === undefined) throw new Error('no *leave-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, leaveSchemaFile)) as LeaveMigrationModule
}

function loadRealMigration(): { up: (pgm: MigrationBuilder) => void; down: (pgm: MigrationBuilder) => void } {
  const files = migrationFiles()
  const leaveSchemaFile = files.find((f) => f.includes('leave-schema'))
  if (leaveSchemaFile === undefined) throw new Error('no *leave-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, leaveSchemaFile)) as {
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
 * `createIndex`, `sql`, `dropSchema`, `func`). It records every call so two
 * independent runs of `up()` can be compared for determinism, which is
 * this test file's proxy for "safe to re-run" at the JS level.
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

describe('leave schema migration — applies cleanly and deterministically', () => {
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
    expect(createSchemaCall?.args).toEqual(['leave', { ifNotExists: true }])
  })

  it('down drops the schema with ifExists: true, mirroring the up side', () => {
    const migration = loadMigration()
    const pgm = new FakePgm()
    migration.down(pgm)
    const dropSchemaCall = pgm.calls.find((c) => c.method === 'dropSchema')
    expect(dropSchemaCall).toBeDefined()
    expect(dropSchemaCall?.args).toEqual(['leave', { cascade: true, ifExists: true }])
  })
})

describe('leave schema migration — attachment_ref is bytea (medical certificate, PDPA s.26)', () => {
  it('leave_request.attachment_ref is declared bytea, by name', () => {
    const source = migrationSource()
    const columnMatch = /attachment_ref:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'bytea'/)
  })

  it('the ONLY bytea column anywhere in the leave schema is leave_request.attachment_ref — enumerated explicitly', () => {
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
    expect(byteaColumns).toEqual(['attachment_ref'])
  })

  it('the same assertion FAILS if attachment_ref is changed to text in the source', () => {
    const source = migrationSource()
    const mutated = source.replace(
      /attachment_ref:\s*\{\s*type:\s*'bytea'\s*\}/,
      "attachment_ref: { type: 'text' }",
    )
    expect(mutated).not.toEqual(source) // the replace actually matched something
    const columnMatch = /attachment_ref:\s*\{[^}]*\}/.exec(mutated)
    expect(columnMatch?.[0]).not.toMatch(/type:\s*'bytea'/)
  })
})

describe('leave schema migration — balance/day columns are numeric, never real/double precision', () => {
  const NUMERIC_COLUMNS = ['entitled', 'taken', 'carried_over', 'days'] as const

  it.each(NUMERIC_COLUMNS)('%s is declared numeric, by name', (column) => {
    const source = migrationSource()
    const columnMatch = new RegExp(`\\b${column}:\\s*\\{[^}]*\\}`).exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'numeric'/)
    expect(columnMatch?.[0]).not.toMatch(/type:\s*'real'/)
    expect(columnMatch?.[0]).not.toMatch(/type:\s*'double precision'/)
  })

  it('there is no real/double precision column anywhere in this schema', () => {
    const source = migrationSource()
    expect(source).not.toMatch(/type:\s*'real'/)
    expect(source).not.toMatch(/type:\s*'double precision'/)
  })

  /**
   * Demonstrates the assertion above is load-bearing, not decorative
   * (Task 14 brief: "a demonstration that the numeric assertion FAILS
   * when one balance column is changed to double precision"). Run inline
   * against a mutated copy of the real source rather than the file on
   * disk, so a stray CI run can never see a mutated migration.
   */
  it('the "entitled is numeric" assertion FAILS when entitled is changed to double precision', () => {
    const source = migrationSource()
    const mutated = source.replace(
      "entitled: { type: 'numeric', notNull: true }",
      "entitled: { type: 'double precision', notNull: true }",
    )
    expect(mutated).not.toEqual(source) // the replace actually matched something

    const columnMatch = /entitled:\s*\{[^}]*\}/.exec(mutated)
    expect(columnMatch).not.toBeNull()
    // This is the failing assertion itself, proven by inverting it: the
    // real (un-mutated) check `expect(columnMatch?.[0]).toMatch(/type:\s*'numeric'/)`
    // would throw against `mutated`, which is exactly what this line proves.
    expect(columnMatch?.[0]).not.toMatch(/type:\s*'numeric'/)
    expect(columnMatch?.[0]).toMatch(/type:\s*'double precision'/)
  })
})

describe('leave schema migration — statutory_rule_key (nullable on purpose)', () => {
  it('exists on leave_type and is nullable (no notNull: true anywhere in its definition)', () => {
    const source = migrationSource()
    const columnMatch = /statutory_rule_key:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'text'/)
    expect(columnMatch?.[0]).not.toMatch(/notNull:\s*true/)
  })

  it('carries a COMMENT ON COLUMN explaining the nullability is deliberate, not an oversight', () => {
    const source = migrationSource()
    expect(source).toMatch(/COMMENT ON COLUMN leave\.leave_type\.statutory_rule_key/)
    expect(source).toMatch(/NULLABLE ON PURPOSE/)
  })
})

describe('leave schema migration — no foreign key crosses a schema boundary', () => {
  it('every `references` block in this migration points at the leave schema itself', () => {
    const source = migrationSource()
    const referencesBlocks = source.match(/references:\s*\{[^}]*\}/g) ?? []
    expect(referencesBlocks.length).toBeGreaterThan(0) // sanity: this migration does use FKs (leave_type_id)
    for (const block of referencesBlocks) {
      expect(block).toMatch(/schema:\s*'leave'/)
    }
  })

  it('leave_employee_ref (the employee.* read model) has no references block at all', () => {
    const source = migrationSource()
    const block = /name:\s*['"]leave_employee_ref['"][\s\S]{0,400}/.exec(source)?.[0] ?? ''
    expect(block).not.toMatch(/references:/)
  })

  it('approval_step.subject_id has no FK — matches the brief\'s shape exactly (unlike leave_type_id, which is explicitly fk)', () => {
    const source = migrationSource()
    const block = /name:\s*['"]approval_step['"][\s\S]{0,700}/.exec(source)?.[0] ?? ''
    expect(block).toMatch(/subject_id:\s*\{\s*type:\s*'uuid'/)
    expect(block).not.toMatch(/subject_id:\s*\{[^}]*references:/)
  })
})

describe('leave schema migration — processed_events / outbox (standard shape)', () => {
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

describe('leave schema migration — every DATABASE-DESIGN.md §2.4 column is present', () => {
  it('leave_type has every specified column', () => {
    const source = migrationSource()
    for (const column of ['id', 'code', 'name_i18n', 'pay_mode', 'accrual_mode', 'statutory_rule_key']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('leave_balance has every specified column', () => {
    const source = migrationSource()
    for (const column of ['employee_id', 'leave_type_id', 'entitled', 'taken', 'carried_over', 'year']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('leave_request has every specified column', () => {
    const source = migrationSource()
    for (const column of ['employee_id', 'leave_type_id', 'dates', 'days', 'attachment_ref', 'status']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('leave_request.dates is a daterange', () => {
    const source = migrationSource()
    const columnMatch = /dates:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch?.[0]).toMatch(/type:\s*'daterange'/)
  })

  it('approval_step has every specified column', () => {
    const source = migrationSource()
    for (const column of ['subject_id', 'level', 'approver_role', 'approver_id', 'decided_at', 'decision', 'comment']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('leave_employee_ref exists with employee_id as its primary key', () => {
    const source = migrationSource()
    expect(source).toMatch(/name:\s*['"]leave_employee_ref['"]/)
    const block = /name:\s*['"]leave_employee_ref['"][\s\S]{0,300}/.exec(source)?.[0] ?? ''
    expect(block).toMatch(/employee_id:\s*\{\s*type:\s*'uuid',\s*primaryKey:\s*true/)
  })
})

describe('leave schema migration — constraints actually created by node-pg-migrate (Task 16c)', () => {
  it('leave_type_code_key: UNIQUE (code)', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "leave_type_code_key" UNIQUE \("code"\);/)
  })

  it('leave_type_pay_mode_check / leave_type_accrual_mode_check', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "leave_type_pay_mode_check" CHECK \(pay_mode IN \('full', 'half', 'unpaid', 'per_rule'\)\);/,
    )
    expect(sql).toMatch(
      /ADD CONSTRAINT "leave_type_accrual_mode_check" CHECK \(accrual_mode IN \('annual_grant', 'monthly', 'anniversary'\)\);/,
    )
  })

  /**
   * The natural key this table models (DATABASE-DESIGN.md §2.4's
   * `LEAVE_TYPE ||--o{ LEAVE_BALANCE : accrues`) — without it, two balance
   * rows for the same employee/type/year could coexist with no defined
   * "current" one.
   */
  it('leave_balance_employee_type_year_key: UNIQUE (employee_id, leave_type_id, year)', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "leave_balance_employee_type_year_key" UNIQUE \("employee_id", "leave_type_id", "year"\);/,
    )
  })

  it('leave_request_status_check', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "leave_request_status_check" CHECK \(status IN \('pending', 'approved', 'rejected', 'cancelled'\)\);/,
    )
  })

  it('approval_step_decision_check', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "approval_step_decision_check" CHECK \(decision IS NULL OR decision IN \('approved', 'rejected'\)\);/,
    )
  })

  /**
   * Regression proof, kept executable: reconstructs the exact broken
   * options object every one of the six constraints above used to be
   * declared with, and proves it produces nothing — this is what the old
   * (nonexistent) test coverage would have needed to catch Task 16c's bug.
   */
  it('the OLD { constraints: { <name>: { unique/check: ... } } } shape produces no constraint at all', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'leave', name: 'leave_type_regression_check' },
        { code: { type: 'text', notNull: true } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used.
        { constraints: { leave_type_code_key: { unique: ['code'] } } } as any,
      )
    })
    expect(sql).not.toMatch(/UNIQUE/)
    expect(sql).not.toMatch(/leave_type_code_key/)
  })
})
