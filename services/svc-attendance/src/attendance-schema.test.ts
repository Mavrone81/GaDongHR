import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Proves the migration's SQL shape directly — no database available in
 * this environment (Task 14 brief CONSTRAINTS, matching Tasks 7/8/9's
 * precedent). Three assertion strategies are used:
 *
 *  1. Regex assertions against the migration file's own source text
 *     (`migrationSource()`), the same technique `services/svc-audit`'s
 *     `migration.test.ts` established — used only for column-shape
 *     assertions (types, presence), never for constraint existence (see 3).
 *  2. A structural run of `exports.up` against a minimal fake
 *     `MigrationBuilder` (`FakePgm`) that records every builder call it
 *     receives — this proves the migration function is a deterministic,
 *     side-effect-free sequence of builder calls (the property that makes
 *     re-running it safe; real re-run idempotency for an *already applied*
 *     migration is `node-pg-migrate`'s job via its `pgmigrations` ledger,
 *     which `src/main.ts` wires exactly as `services/svc-config` does).
 *  3. (Task 16c) Constraint-existence assertions run the migration against
 *     node-pg-migrate's REAL `MigrationBuilderImpl` — the same class
 *     `Migration.apply()` constructs internally
 *     (`node_modules/node-pg-migrate/dist/migration.js`) — and inspect the
 *     actual generated SQL. This is the test-gap fix Task 16c's brief
 *     requires: a regex against source text cannot distinguish
 *     node-pg-migrate's valid `constraints: { unique: [...] }` shape from
 *     the invalid `constraints: { someName: { unique: [...] } } }` shape
 *     that silently creates nothing — both "look like" a constraint
 *     declaration to a text scanner. Only running the options object
 *     through node-pg-migrate's own `parseConstraints`
 *     (`dist/operations/tables/shared.js`) reveals the difference. Every
 *     `unique`/`check` constraint assertion in this file uses strategy 3, not
 *     1 — this file used to assert against source text alone (regex 1) for
 *     these, which is exactly how the original `{ constraints: { <name>: {
 *     unique: [...] } } }` bug shipped undetected.
 *
 * The single most important suite here is "no column in this schema can
 * hold a face embedding" — it is the test that keeps a biometric template
 * out of the database (Task 14 brief, "why this service matters").
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

interface AttendanceMigrationModule {
  up: (pgm: FakePgm) => void
  down: (pgm: FakePgm) => void
}

function loadMigration(): AttendanceMigrationModule {
  const files = migrationFiles()
  const attendanceSchemaFile = files.find((f) => f.includes('attendance-schema'))
  if (attendanceSchemaFile === undefined) throw new Error('no *attendance-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, attendanceSchemaFile)) as AttendanceMigrationModule
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

/**
 * `MigrationBuilderImpl`'s constructor only touches `db` to hand
 * `pgm.db.query`/`pgm.db.select` through to a migration that calls them
 * directly — this migration never does, so a `db` that throws if ever
 * actually invoked is a safe, honest stand-in for "no Postgres in this
 * environment".
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

/** Runs `action` against a real node-pg-migrate `MigrationBuilder` and returns the exact SQL it would emit — see file header, strategy 3. */
function buildSql(action: (pgm: MigrationBuilder) => void): string {
  const pgm = new MigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
  action(pgm)
  return pgm.getSql()
}

/** Loads the migration typed against the real `MigrationBuilder`, for use with `buildSql`. */
function loadRealMigration(): { up: (pgm: MigrationBuilder) => void; down: (pgm: MigrationBuilder) => void } {
  const files = migrationFiles()
  const attendanceSchemaFile = files.find((f) => f.includes('attendance-schema'))
  if (attendanceSchemaFile === undefined) throw new Error('no *attendance-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, attendanceSchemaFile)) as {
    up: (pgm: MigrationBuilder) => void
    down: (pgm: MigrationBuilder) => void
  }
}

describe('attendance schema migration — applies cleanly and deterministically', () => {
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
    expect(createSchemaCall?.args).toEqual(['attendance', { ifNotExists: true }])
  })

  it('down drops the schema with ifExists: true, mirroring the up side', () => {
    const migration = loadMigration()
    const pgm = new FakePgm()
    migration.down(pgm)
    const dropSchemaCall = pgm.calls.find((c) => c.method === 'dropSchema')
    expect(dropSchemaCall).toBeDefined()
    expect(dropSchemaCall?.args).toEqual(['attendance', { cascade: true, ifExists: true }])
  })
})

describe('attendance schema migration — no column can hold a face embedding', () => {
  it('face_subject_ref is declared text, never bytea or any other binary type', () => {
    const source = migrationSource()
    expect(source).toMatch(/face_subject_ref:\s*\{\s*type:\s*'text'/)
    expect(source).not.toMatch(/face_subject_ref:\s*\{[^}]*type:\s*'bytea'/)
  })

  it('the ONLY bytea column anywhere in the attendance schema is device.device_secret — enumerated explicitly', () => {
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
    // that keeps a face embedding out of the database (Task 14 brief).
    expect(byteaColumns).toEqual(['device_secret'])
  })

  it('there is no column anywhere in this schema named anything embedding/template-shaped that is binary', () => {
    const source = migrationSource()
    // Belt-and-brace against a differently-named column trying to smuggle
    // template bytes in under another name.
    const suspiciousNamePattern = /(embedding|template|face_vector|biometric_data)\w*:\s*\{\s*type:\s*'bytea'/gi
    expect(source).not.toMatch(suspiciousNamePattern)
  })
})

describe('attendance schema migration — idem_key uniqueness (offline kiosk replay protection)', () => {
  /**
   * Task 16c: runs the migration through node-pg-migrate's REAL
   * `MigrationBuilder` (not a source-text regex — see file header, strategy
   * 3) and asserts the generated SQL actually contains the constraint. This
   * is the assertion that would have caught the original
   * `{ constraints: { punch_event_idem_key_key: { unique: [...] } } } }` bug
   * — that shape passed the old source-regex test (it "looks like" a
   * constraint) while node-pg-migrate silently created nothing from it.
   */
  it('punch_event has a UNIQUE constraint on idem_key, actually created by node-pg-migrate', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "punch_event_idem_key_key" UNIQUE \("idem_key"\);/)
  })

  /**
   * Regression proof, kept executable rather than a one-off manual run:
   * reconstructs the exact broken options object this file used before
   * Task 16c's fix and proves it produces no UNIQUE constraint at all —
   * demonstrating the assertion above really is load-bearing.
   */
  it('the OLD { constraints: { punch_event_idem_key_key: { unique: [...] } } } shape produces no UNIQUE constraint', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'attendance', name: 'punch_event_regression_check' },
        { idem_key: { type: 'text', notNull: true } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used.
        { constraints: { punch_event_idem_key_key: { unique: ['idem_key'] } } } as any,
      )
    })
    expect(sql).not.toMatch(/UNIQUE/)
    expect(sql).not.toMatch(/punch_event_idem_key_key/)
  })
})

describe('attendance schema migration — enrollment.employee_id UNIQUE (one enrolment per person)', () => {
  it('enrollment has a UNIQUE constraint on employee_id, actually created by node-pg-migrate', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "enrollment_employee_id_key" UNIQUE \("employee_id"\);/)
  })

  it('the OLD { constraints: { enrollment_employee_id_key: { unique: [...] } } } shape produces no UNIQUE constraint', () => {
    const sql = buildSql((pgm) => {
      pgm.createTable(
        { schema: 'attendance', name: 'enrollment_regression_check' },
        { employee_id: { type: 'uuid', notNull: true } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately reconstructing the exact malformed (not TableOptions-shaped) options object the original defect used.
        { constraints: { enrollment_employee_id_key: { unique: ['employee_id'] } } } as any,
      )
    })
    expect(sql).not.toMatch(/UNIQUE/)
    expect(sql).not.toMatch(/enrollment_employee_id_key/)
  })
})

describe('attendance schema migration — template_deleted_at (PDPA §7 deletion evidence)', () => {
  it('exists on enrollment and is nullable (no notNull: true anywhere in its definition)', () => {
    const source = migrationSource()
    const columnMatch = /template_deleted_at:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'timestamptz'/)
    expect(columnMatch?.[0]).not.toMatch(/notNull:\s*true/)
  })
})

describe('attendance schema migration — match_score (numeric, nullable)', () => {
  it('is numeric and nullable — a PIN punch has no score', () => {
    const source = migrationSource()
    const columnMatch = /match_score:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'numeric'/)
    expect(columnMatch?.[0]).not.toMatch(/notNull:\s*true/)
  })
})

describe('attendance schema migration — processed_events / outbox (standard shape)', () => {
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

describe('attendance schema migration — device.device_secret (S3, encrypted before write)', () => {
  it('is bytea and not null', () => {
    const source = migrationSource()
    const columnMatch = /device_secret:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'bytea'/)
    expect(columnMatch?.[0]).toMatch(/notNull:\s*true/)
  })
})

describe('attendance schema migration — every DATABASE-DESIGN.md §2.2 column is present', () => {
  it('enrollment has every specified column', () => {
    const source = migrationSource()
    for (const column of ['id', 'employee_id', 'method', 'face_subject_ref', 'status', 'enrolled_at', 'template_deleted_at']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('device has every specified column', () => {
    const source = migrationSource()
    for (const column of ['kind', 'site_code', 'device_secret', 'status']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('punch_event has every specified column', () => {
    const source = migrationSource()
    for (const column of [
      'idem_key',
      'employee_id',
      'device_id',
      'punched_at',
      'direction',
      'method',
      'match_score',
      'liveness_passed',
      'site_code',
      'geo',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('attendance_employee_ref exists and has no FK/references to another schema', () => {
    const source = migrationSource()
    expect(source).toMatch(/name:\s*['"]attendance_employee_ref['"]/)
    const block = /name:\s*['"]attendance_employee_ref['"][\s\S]{0,400}/.exec(source)?.[0] ?? ''
    expect(block).not.toMatch(/references:/)
  })
})
