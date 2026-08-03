import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Proves the `retention` schema migration's SQL shape directly — no
 * database available in this environment (Task 14 brief CONSTRAINTS,
 * matching Tasks 7/8/9/13's precedent). Three assertion strategies:
 *
 *  1. Regex assertions against the migration file's own source text
 *     (`migrationSource()`) — used only for column-shape assertions, never
 *     for constraint existence (see 3).
 *  2. A structural run of `exports.up`/`exports.down` against a minimal
 *     fake `MigrationBuilder` (`FakePgm`) that records every builder call
 *     it receives — proves the migration is a deterministic, side-effect-
 *     free sequence of builder calls, which is what makes re-running it
 *     safe (real re-run idempotency for an *already applied* migration is
 *     `node-pg-migrate`'s job via its `pgmigrations` ledger, wired in
 *     `src/main.ts` exactly as `services/svc-config` does).
 *  3. (Task 16c) Constraint-existence assertions run the migration against
 *     node-pg-migrate's REAL `MigrationBuilderImpl` — the same class
 *     `Migration.apply()` constructs internally — and inspect the actual
 *     generated SQL. Every constraint in this file used to be declared via
 *     node-pg-migrate's silently-ignored `{ constraints: { <name>: {...} } }`
 *     shape, and the tests below used to be source-text regexes that could
 *     not tell the difference between that (broken) shape and a working
 *     one — exactly how the bug shipped undetected.
 *
 * The suites below are grouped around the Task 14 brief's three
 * structural rules (legal hold, the review-gated status CHECK, and
 * `erased_at` surviving its subject) — those are the point of this file.
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

interface RetentionMigrationModule {
  up: (pgm: FakePgm) => void
  down: (pgm: FakePgm) => void
}

function loadMigration(): RetentionMigrationModule {
  const files = migrationFiles()
  const retentionSchemaFile = files.find((f) => f.includes('retention-schema'))
  if (retentionSchemaFile === undefined) throw new Error('no *retention-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, retentionSchemaFile)) as RetentionMigrationModule
}

function loadRealMigration(): { up: (pgm: MigrationBuilder) => void; down: (pgm: MigrationBuilder) => void } {
  const files = migrationFiles()
  const retentionSchemaFile = files.find((f) => f.includes('retention-schema'))
  if (retentionSchemaFile === undefined) throw new Error('no *retention-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, retentionSchemaFile)) as {
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
 * `attendance-schema.test.ts` defines.
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

describe('retention schema migration — applies cleanly and deterministically', () => {
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
    expect(createSchemaCall?.args).toEqual(['retention', { ifNotExists: true }])
  })

  it('down drops the schema with ifExists: true, mirroring the up side', () => {
    const migration = loadMigration()
    const pgm = new FakePgm()
    migration.down(pgm)
    const dropSchemaCall = pgm.calls.find((c) => c.method === 'dropSchema')
    expect(dropSchemaCall).toBeDefined()
    expect(dropSchemaCall?.args).toEqual(['retention', { cascade: true, ifExists: true }])
  })
})

describe('retention schema migration — rule 1: legal_hold_reason exists and is nullable', () => {
  it('candidate.legal_hold_reason is text and carries no notNull: true', () => {
    const source = migrationSource()
    const columnMatch = /legal_hold_reason:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'text'/)
    expect(columnMatch?.[0]).not.toMatch(/notNull:\s*true/)
  })
})

describe('retention schema migration — rule 2: status CHECK covers all six states, by name', () => {
  const requiredStates = [
    'identified',
    'awaiting_review',
    'approved',
    'erased',
    'blocked_legal_hold',
    'blocked_conflict',
  ]

  /**
   * Task 16c: these used to be source-text regexes against
   * `candidate_status_check:\s*\{\s*check:...` — the exact shape
   * node-pg-migrate's `parseConstraints` silently ignores (the name is
   * nested one level inside `options.constraints` instead of being a
   * recognised kind), so the old regex passed while the constraint itself
   * never existed. This now runs the migration through node-pg-migrate's
   * REAL `MigrationBuilderImpl` and inspects the actual generated SQL.
   */
  it.each(requiredStates)('candidate_status_check names %s, actually created by node-pg-migrate', (state) => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    const checkMatch = /ADD CONSTRAINT "candidate_status_check" CHECK \(status IN \(([^)]*)\)\);/.exec(sql)
    expect(checkMatch).not.toBeNull()
    expect(checkMatch?.[1] ?? '').toContain(`'${state}'`)
  })

  it('names exactly six states — no more, no fewer', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    const checkMatch = /ADD CONSTRAINT "candidate_status_check" CHECK \(status IN \(([^)]*)\)\);/.exec(sql)
    const checkExpression = checkMatch?.[1] ?? ''
    const namedStates = [...checkExpression.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(namedStates.sort()).toEqual([...requiredStates].sort())
  })

  it('a candidate can never reach erased without having passed review: candidate_erased_requires_review_check requires reviewed_by, reviewed_at and erased_at all be set', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    const checkMatch = /ADD CONSTRAINT "candidate_erased_requires_review_check" CHECK \(([^;]*)\);/.exec(sql)
    expect(checkMatch).not.toBeNull()
    const checkExpression = checkMatch?.[1] ?? ''
    expect(checkExpression).toContain("status <> 'erased'")
    expect(checkExpression).toContain('reviewed_by IS NOT NULL')
    expect(checkExpression).toContain('reviewed_at IS NOT NULL')
    expect(checkExpression).toContain('erased_at IS NOT NULL')
  })

  /**
   * Regression proof, kept executable rather than a one-off manual run:
   * reconstructs the exact broken options object this file used before
   * Task 16c's fix and proves it produces no CHECK constraint at all.
   */
  it('the OLD { constraints: { candidate_status_check: { check: ... } } } shape produces no CHECK constraint', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'retention', name: 'candidate_regression_check' },
        { status: { type: 'text', notNull: true } },
        {
          constraints: {
            candidate_status_check: {
              check:
                "status IN ('identified', 'awaiting_review', 'approved', 'erased', 'blocked_legal_hold', 'blocked_conflict')",
            },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used.
        } as any,
      )
    })
    expect(sql).not.toMatch(/CHECK/)
    expect(sql).not.toMatch(/candidate_status_check/)
  })
})

describe('retention schema migration — rule 3: erased_at survives its subject', () => {
  it('candidate.erased_at exists, is timestamptz, and is nullable (erasure is recorded on the row, not by the row disappearing)', () => {
    const source = migrationSource()
    const columnMatch = /erased_at:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'timestamptz'/)
    expect(columnMatch?.[0]).not.toMatch(/notNull:\s*true/)
  })

  it('entity_type and entity_id carry no `references:` — no cross-schema FK exists that could cascade a candidate away when its subject is deleted elsewhere', () => {
    const source = migrationSource()
    const entityTypeMatch = /entity_type:\s*\{[^}]*\}/.exec(source)
    const entityIdMatch = /entity_id:\s*\{[^}]*\}/.exec(source)
    expect(entityTypeMatch).not.toBeNull()
    expect(entityIdMatch).not.toBeNull()
    expect(entityTypeMatch?.[0]).not.toMatch(/references:/)
    expect(entityIdMatch?.[0]).not.toMatch(/references:/)
  })

  it('the only FK candidate carries (policy_id -> policy.id) declares no onDelete — a policy cannot be deleted out from under its candidates, and nothing here cascades a candidate delete', () => {
    const source = migrationSource()
    // Lazy match up to `candidate_policy_id_fkey`, then up to the very next
    // `}` — the outer closing brace of the `policy_id` column definition
    // (the nested `references: { ... }` object's own brace closes *before*
    // `candidate_policy_id_fkey` appears in the source, so it can't
    // interfere with finding this one).
    const policyIdBlockMatch = /policy_id:\s*\{[\s\S]*?candidate_policy_id_fkey[\s\S]*?\}/.exec(source)
    expect(policyIdBlockMatch).not.toBeNull()
    expect(policyIdBlockMatch?.[0]).not.toMatch(/onDelete/)
  })

  it('there is no ON DELETE CASCADE anywhere in this migration', () => {
    const source = migrationSource()
    expect(source).not.toMatch(/onDelete:\s*['"]CASCADE['"]/i)
  })
})

describe('retention schema migration — policy.retention_period is an interval, not a magic day-count', () => {
  it('retention_period is declared type interval', () => {
    const source = migrationSource()
    const columnMatch = /retention_period:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'interval'/)
    expect(columnMatch?.[0]).toMatch(/notNull:\s*true/)
  })

  it('seeds express "2 years" and "5 years" as interval literals, not integer day counts', () => {
    const source = migrationSource()
    expect(source).toMatch(/interval '2 years'/)
    expect(source).toMatch(/interval '5 years'/)
    expect(source).toMatch(/interval '7 days'/)
  })
})

describe('retention schema migration — policy is effective-dated', () => {
  it('effective_from is date and notNull', () => {
    const source = migrationSource()
    const columnMatch = /effective_from:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'date'/)
    expect(columnMatch?.[0]).toMatch(/notNull:\s*true/)
  })

  it('effective_to is date and nullable', () => {
    const source = migrationSource()
    const columnMatch = /effective_to:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'date'/)
    expect(columnMatch?.[0]).not.toMatch(/notNull:\s*true/)
  })

  it('policy is unique on (data_class, effective_from) — a re-legislated data class gets a new row, never an in-place overwrite, actually created by node-pg-migrate (Task 16c)', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "policy_data_class_effective_from_key" UNIQUE \("data_class", "effective_from"\);/,
    )
  })

  it('the OLD { constraints: { policy_data_class_effective_from_key: { unique: [...] } } } shape produces no UNIQUE constraint (regression proof)', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'retention', name: 'policy_regression_check' },
        { data_class: { type: 'text', notNull: true }, effective_from: { type: 'date', notNull: true } },
        {
          constraints: {
            policy_data_class_effective_from_key: { unique: ['data_class', 'effective_from'] },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used.
        } as any,
      )
    })
    expect(sql).not.toMatch(/UNIQUE/)
    expect(sql).not.toMatch(/policy_data_class_effective_from_key/)
  })
})

describe('retention schema migration — run.status CHECK (Task 16c)', () => {
  it('run_status_check is actually created by node-pg-migrate', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(
      /ADD CONSTRAINT "run_status_check" CHECK \(status IN \('running', 'completed', 'failed'\)\);/,
    )
  })
})

describe('retention schema migration — processed_events / no outbox', () => {
  it('processed_events has event_id as its primary key', () => {
    const source = migrationSource()
    expect(source).toMatch(/name:\s*['"]processed_events['"][\s\S]{0,300}event_id[\s\S]{0,100}primaryKey:\s*true/)
  })

  it('creates no outbox table — this service does not publish any retention.* event (see event catalog)', () => {
    const source = migrationSource()
    expect(/name:\s*['"]outbox['"]/i.test(source)).toBe(false)
  })
})

describe('retention schema migration — every Task 14 brief column is present', () => {
  it('policy has every specified column', () => {
    const source = migrationSource()
    for (const column of ['id', 'data_class', 'table_ref', 'retention_period', 'legal_driver', 'effective_from', 'effective_to']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('candidate has every specified column', () => {
    const source = migrationSource()
    for (const column of [
      'id',
      'policy_id',
      'entity_type',
      'entity_id',
      'identified_at',
      'eligible_at',
      'status',
      'reviewed_by',
      'reviewed_at',
      'erased_at',
      'legal_hold_reason',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('run has every specified column', () => {
    const source = migrationSource()
    for (const column of ['id', 'started_at', 'finished_at', 'candidates_found', 'candidates_erased', 'status']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })
})

describe('retention schema migration — PDPA §7 seed data', () => {
  it('seeds all nine PDPA-BIOMETRIC-COMPLIANCE.md §7 data classes', () => {
    const source = migrationSource()
    for (const dataClass of [
      'face_template',
      'enrolment_raw_image',
      'punch_attendance_record',
      'employee_register_wage_ot_docs',
      'payroll_tax_record',
      'accounting_payroll_journal',
      'sick_leave_medical_certificate',
      'consent_record',
      'candidate_data_never_hired',
    ]) {
      expect(source).toMatch(new RegExp(`'${dataClass}'`))
    }
  })

  it('conflicts resolve toward the longest legally required period: payroll/tax (5 years) seeds longer than punch records (2 years), per §7\'s "never longer than required, always the longest required" rule', () => {
    const source = migrationSource()
    const insertBlockMatch = /INSERT INTO retention\.policy[\s\S]*?;/.exec(source) ?? /INSERT INTO retention\.policy[\s\S]*/.exec(source)
    expect(insertBlockMatch).not.toBeNull()
    const block = insertBlockMatch?.[0] ?? ''
    expect(block).toMatch(/'payroll_tax_record'[\s\S]*?interval '5 years'/)
    expect(block).toMatch(/'punch_attendance_record'[\s\S]*?interval '2 years'/)
  })
})
