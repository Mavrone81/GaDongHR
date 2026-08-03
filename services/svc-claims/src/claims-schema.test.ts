import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Proves the migration's SQL shape directly — no database available in
 * this environment (Task 14 brief CONSTRAINTS, matching Tasks 7/8/9/13/14's
 * precedent). Two assertion strategies are used, matching the brief's
 * "assert against the migration's generated SQL or a fake":
 *
 *  1. Regex assertions against the migration file's own source text
 *     (`migrationSource()`), the same technique
 *     `services/svc-leave/src/leave-schema.test.ts` established.
 *  2. A structural run of `exports.up` against a minimal fake
 *     `MigrationBuilder` (`FakePgm`) that records every builder call it
 *     receives — this proves the migration function is a deterministic,
 *     side-effect-free sequence of builder calls (the property that makes
 *     re-running it safe; real re-run idempotency for an *already applied*
 *     migration is `node-pg-migrate`'s job via its `pgmigrations` ledger,
 *     which `src/main.ts` wires exactly as `services/svc-config` does).
 *
 * The suites the Task 14 brief calls out by name: `receipt.file_ref` is
 * `bytea` (uncontrolled user content that can incidentally contain
 * medical information); `amount_thb`/`vat_amount` are `numeric` (these
 * become a non-taxable payroll line — a rounding error is a payroll
 * error and a wrong SSO filing); `dup_hash` exists AND is indexed, with
 * the index requirement demonstrated to actually fail when removed; and
 * `status` carries a CHECK listing exactly the six ERD states.
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

interface ClaimsMigrationModule {
  up: (pgm: FakePgm) => void
  down: (pgm: FakePgm) => void
}

function loadMigration(): ClaimsMigrationModule {
  const files = migrationFiles()
  const claimsSchemaFile = files.find((f) => f.includes('claims-schema'))
  if (claimsSchemaFile === undefined) throw new Error('no *claims-schema*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, claimsSchemaFile)) as ClaimsMigrationModule
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

  /** node-pg-migrate's `pgm.func(expr)` wraps a raw SQL expression (e.g. `now()`) so it isn't quoted as a string literal default — here it's just an identity tag, sufficient for structural comparison. */
  func(expr: string): { __rawSqlFunc: string } {
    return { __rawSqlFunc: expr }
  }
}

describe('claims schema migration — applies cleanly and deterministically', () => {
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
    expect(createSchemaCall?.args).toEqual(['claims', { ifNotExists: true }])
  })

  it('down drops the schema with ifExists: true, mirroring the up side', () => {
    const migration = loadMigration()
    const pgm = new FakePgm()
    migration.down(pgm)
    const dropSchemaCall = pgm.calls.find((c) => c.method === 'dropSchema')
    expect(dropSchemaCall).toBeDefined()
    expect(dropSchemaCall?.args).toEqual(['claims', { cascade: true, ifExists: true }])
  })
})

describe('claims schema migration — receipt.file_ref is bytea (uncontrolled user content, may contain medical info)', () => {
  it('receipt.file_ref is declared bytea, by name', () => {
    const source = migrationSource()
    const columnMatch = /file_ref:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'bytea'/)
  })

  it('the ONLY bytea column anywhere in the claims schema is receipt.file_ref — enumerated explicitly', () => {
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
    expect(byteaColumns).toEqual(['file_ref'])
  })

  it('the same assertion FAILS if file_ref is changed to text in the source', () => {
    const source = migrationSource()
    const mutated = source.replace(
      "file_ref: { type: 'bytea', notNull: true }",
      "file_ref: { type: 'text', notNull: true }",
    )
    expect(mutated).not.toEqual(source) // the replace actually matched something
    const columnMatch = /file_ref:\s*\{[^}]*\}/.exec(mutated)
    expect(columnMatch?.[0]).not.toMatch(/type:\s*'bytea'/)
  })
})

describe('claims schema migration — amount_thb / vat_amount are numeric, never real/double precision', () => {
  const NUMERIC_COLUMNS = ['amount_thb', 'vat_amount'] as const

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
   * (Task 14 brief: "amount_thb and vat_amount are numeric, never
   * float" — demonstrate the assertion fails on a mutation). Run inline
   * against a mutated copy of the real source rather than the file on
   * disk, so a stray CI run can never see a mutated migration.
   */
  it('the "amount_thb is numeric" assertion FAILS when amount_thb is changed to double precision', () => {
    const source = migrationSource()
    const mutated = source.replace(
      "amount_thb: { type: 'numeric', notNull: true }",
      "amount_thb: { type: 'double precision', notNull: true }",
    )
    expect(mutated).not.toEqual(source) // the replace actually matched something

    const columnMatch = /amount_thb:\s*\{[^}]*\}/.exec(mutated)
    expect(columnMatch).not.toBeNull()
    // This is the failing assertion itself, proven by inverting it: the
    // real (un-mutated) check `expect(columnMatch?.[0]).toMatch(/type:\s*'numeric'/)`
    // would throw against `mutated`, which is exactly what this line proves.
    expect(columnMatch?.[0]).not.toMatch(/type:\s*'numeric'/)
    expect(columnMatch?.[0]).toMatch(/type:\s*'double precision'/)
  })

  it('the "vat_amount is numeric" assertion FAILS when vat_amount is changed to real', () => {
    const source = migrationSource()
    const mutated = source.replace("vat_amount: { type: 'numeric' }", "vat_amount: { type: 'real' }")
    expect(mutated).not.toEqual(source) // the replace actually matched something

    const columnMatch = /vat_amount:\s*\{[^}]*\}/.exec(mutated)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).not.toMatch(/type:\s*'numeric'/)
    expect(columnMatch?.[0]).toMatch(/type:\s*'real'/)
  })
})

describe('claims schema migration — dup_hash exists and is indexed (M6-5 duplicate-receipt detection)', () => {
  it('claim.dup_hash is declared text, by name', () => {
    const source = migrationSource()
    const columnMatch = /dup_hash:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'text'/)
  })

  it('an index exists on dup_hash — a createIndex call whose column list includes dup_hash', () => {
    const migration = loadMigration()
    const pgm = new FakePgm()
    migration.up(pgm)
    const dupHashIndexCall = pgm.calls.find(
      (c) => c.method === 'createIndex' && Array.isArray(c.args[1]) && (c.args[1] as unknown[]).includes('dup_hash'),
    )
    expect(dupHashIndexCall).toBeDefined()
  })

  /**
   * Task 14 brief: "Demonstrate the assertion fails when the index is
   * removed." Runs the SAME assertion as the test above against a
   * migration source with the `dup_hash` index's `createIndex` call
   * stripped out, proving the check is load-bearing rather than trivially
   * true. Never mutates the file on disk — only an in-memory copy of the
   * loaded module's `up` function output.
   */
  it('the "dup_hash has an index" assertion FAILS when the index is removed from the migration', () => {
    const migration = loadMigration()
    const pgmWithIndex = new FakePgm()
    migration.up(pgmWithIndex)
    const realHasIndex = pgmWithIndex.calls.some(
      (c) => c.method === 'createIndex' && Array.isArray(c.args[1]) && (c.args[1] as unknown[]).includes('dup_hash'),
    )
    expect(realHasIndex).toBe(true) // sanity: the real migration does have it

    // Simulate "the index was removed" by replaying every call EXCEPT the
    // dup_hash createIndex — i.e. what pgm.calls would look like if that
    // one pgm.createIndex(...) line were deleted from the migration file.
    const callsWithIndexRemoved = pgmWithIndex.calls.filter(
      (c) => !(c.method === 'createIndex' && Array.isArray(c.args[1]) && (c.args[1] as unknown[]).includes('dup_hash')),
    )
    expect(callsWithIndexRemoved.length).toBe(pgmWithIndex.calls.length - 1) // exactly one call removed

    const mutatedHasIndex = callsWithIndexRemoved.some(
      (c) => c.method === 'createIndex' && Array.isArray(c.args[1]) && (c.args[1] as unknown[]).includes('dup_hash'),
    )
    // This is the failing assertion itself, proven by inverting it: the
    // real check `expect(mutatedHasIndex).toBe(true)` would throw against
    // the index-removed call list, which is exactly what this line proves.
    expect(mutatedHasIndex).toBe(false)
  })

  it('the same demonstration holds at the source-text level: stripping the dup_hash createIndex line makes the regex assertion fail', () => {
    const source = migrationSource()
    const dupHashIndexLine =
      "pgm.createIndex({ schema: 'claims', name: 'claim' }, ['dup_hash'], { name: 'claim_dup_hash_idx' })"
    expect(source).toContain(dupHashIndexLine) // sanity: the line exists in the real migration

    const mutated = source.replace(dupHashIndexLine, '')
    expect(mutated).not.toEqual(source) // the replace actually matched something

    const indexOnDupHashPattern = /createIndex\([^)]*\[[^\]]*'dup_hash'[^\]]*\][^)]*\)/
    expect(source).toMatch(indexOnDupHashPattern) // present before mutation
    expect(mutated).not.toMatch(indexOnDupHashPattern) // absent after mutation — the assertion now fails
  })
})

describe('claims schema migration — status CHECK lists exactly the six ERD states', () => {
  const ERD_STATES = ['draft', 'pending', 'approved', 'for_payroll', 'paid_offcycle', 'rejected'] as const

  it('claim_status_check exists with exactly these six states, in this order', () => {
    const source = migrationSource()
    const checkMatch = /claim_status_check:\s*\{\s*check:\s*"([^"]*)"/.exec(source)
    expect(checkMatch).not.toBeNull()
    const checkExpr = checkMatch?.[1] ?? ''
    const listedStates = /IN \(([^)]*)\)/.exec(checkExpr)?.[1] ?? ''
    const states = listedStates.split(',').map((s) => s.trim().replace(/'/g, ''))
    expect(states).toEqual([...ERD_STATES])
  })

  it.each(ERD_STATES)('%s is one of the states in the CHECK', (state) => {
    const source = migrationSource()
    const checkMatch = /claim_status_check:\s*\{\s*check:\s*"([^"]*)"/.exec(source)
    expect(checkMatch?.[1]).toContain(`'${state}'`)
  })

  it('status defaults to draft', () => {
    const source = migrationSource()
    const columnMatch = /status:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch?.[0]).toMatch(/default:\s*'draft'/)
  })
})

describe('claims schema migration — no foreign key crosses a schema boundary', () => {
  it('every `references` block in this migration points at the claims schema itself', () => {
    const source = migrationSource()
    const referencesBlocks = source.match(/references:\s*\{[^}]*\}/g) ?? []
    expect(referencesBlocks.length).toBeGreaterThan(0) // sanity: this migration does use FKs (receipt.claim_id)
    for (const block of referencesBlocks) {
      expect(block).toMatch(/schema:\s*'claims'/)
    }
  })

  it('claims_employee_ref (the employee.* read model) has no references block at all', () => {
    const source = migrationSource()
    const block = /name:\s*['"]claims_employee_ref['"][\s\S]{0,400}/.exec(source)?.[0] ?? ''
    expect(block).not.toMatch(/references:/)
  })

  it("approval_step2.subject_id has no FK — matches leave.approval_step's precedent exactly", () => {
    const source = migrationSource()
    const block = /name:\s*['"]approval_step2['"][\s\S]{0,700}/.exec(source)?.[0] ?? ''
    expect(block).toMatch(/subject_id:\s*\{\s*type:\s*'uuid'/)
    expect(block).not.toMatch(/subject_id:\s*\{[^}]*references:/)
  })
})

describe('claims schema migration — processed_events / outbox (standard shape)', () => {
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

describe('claims schema migration — every DATABASE-DESIGN.md §2.4 column is present', () => {
  it('claim has every specified column', () => {
    const source = migrationSource()
    for (const column of ['id', 'employee_id', 'claim_type', 'amount_thb', 'status', 'dup_hash']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('receipt has every specified column', () => {
    const source = migrationSource()
    for (const column of ['id', 'claim_id', 'file_ref', 'vat_amount']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('receipt.claim_id references claim', () => {
    const source = migrationSource()
    const block = /claim_id:\s*\{[\s\S]{0,200}/.exec(source)?.[0] ?? ''
    expect(block).toMatch(/references:\s*\{\s*schema:\s*'claims',\s*name:\s*'claim'/)
  })

  it('approval_step2 has every specified column', () => {
    const source = migrationSource()
    for (const column of ['subject_id', 'level', 'approver_role', 'approver_id', 'decided_at', 'decision', 'comment']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('claims_employee_ref exists with employee_id as its primary key', () => {
    const source = migrationSource()
    expect(source).toMatch(/name:\s*['"]claims_employee_ref['"]/)
    const block = /name:\s*['"]claims_employee_ref['"][\s\S]{0,300}/.exec(source)?.[0] ?? ''
    expect(block).toMatch(/employee_id:\s*\{\s*type:\s*'uuid',\s*primaryKey:\s*true/)
  })
})
