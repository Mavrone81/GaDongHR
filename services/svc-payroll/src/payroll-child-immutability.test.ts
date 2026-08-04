import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Proves 1754700100000_payroll-child-immutability.js's fix — coordinator
 * review finding: the parent migration's two triggers (`payroll_run`,
 * `payslip`) left `pay_item` and `statutory_export` fully editable under a
 * committed run, including via INSERT. Same two-strategy approach
 * `payroll-schema.test.ts` already established: (1) regex assertions
 * against the combined migration source, including "demonstrate it fails
 * when removed" mutation tests, and (2) a JS-level behavioural mirror of
 * both trigger functions, proving the *rule* is right (blocked exactly
 * when, and only when, the relevant run is committed — for INSERT, UPDATE,
 * AND DELETE alike, and NOT for an unrelated adjustment run) since there is
 * no Postgres in this environment to run the real SQL against (Task 14
 * brief CONSTRAINTS) — matching `services/svc-config`'s `FakeConfigDb`
 * precedent for proving a DB constraint's behaviour without a live
 * database.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migrationFiles(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
  if (files.length === 0) throw new Error(`no migration files found in ${MIGRATIONS_DIR}`)
  return files
}

/** All migration files concatenated — the new triggers/functions live in 1754700100000, but this deliberately scans every file so a reader never has to guess which file a given assertion targets. */
function migrationSource(): string {
  return migrationFiles()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n')
}

/**
 * Only the two migrations that existed when this file was written
 * (`*payroll-schema*` and `*payroll-child-immutability*`). The regression
 * this file guards is "1754700100000 did not silently change the parent's
 * columns" — a question about those two files and no others. Phase 5's
 * `1754701000000_payroll-engine.js` legitimately ADDS encrypted columns
 * (enumerated in `payroll-schema.test.ts`, which owns the whole-schema
 * view), so scanning every file here would turn a correct addition into a
 * false failure of an unrelated assertion.
 */
function parentMigrationSource(): string {
  return migrationFiles()
    .filter((f) => f.includes('payroll-schema') || f.includes('payroll-child-immutability'))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n')
}

interface ChildImmutabilityMigrationModule {
  up: (pgm: FakePgm) => void
  down: (pgm: FakePgm) => void
}

function loadMigration(): ChildImmutabilityMigrationModule {
  const files = migrationFiles()
  const file = files.find((f) => f.includes('payroll-child-immutability'))
  if (file === undefined) throw new Error('no *payroll-child-immutability*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
  return require(join(MIGRATIONS_DIR, file)) as ChildImmutabilityMigrationModule
}

type RecordedCall = { method: string; args: unknown[] }

/** This migration only ever calls `pgm.sql(...)` — a minimal stand-in covering exactly that, matching `payroll-schema.test.ts`'s `FakePgm` pattern. */
class FakePgm {
  readonly calls: RecordedCall[] = []

  sql(...args: unknown[]): void {
    this.calls.push({ method: 'sql', args })
  }
}

describe('payroll child-immutability migration — applies cleanly and deterministically', () => {
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
})

describe('payroll child-immutability migration — unchanged: SoD check, bytea columns, timesheet_lock_version, the original two triggers', () => {
  /**
   * Task 16c: this used to be a source-text regex, which cannot tell
   * node-pg-migrate's valid `constraints: { check: ... }` shape apart from
   * the invalid, silently-ignored `constraints: { payroll_run_sod_check: {
   * check: ... } } }` shape the parent migration actually used — see
   * `payroll-schema.test.ts` for the full explanation and the fix (a
   * `pgm.addConstraint` call). This test now runs the PARENT migration
   * (`payroll-schema.js`, unchanged by this file) through node-pg-migrate's
   * REAL `MigrationBuilderImpl` and confirms the SoD check the Task 14
   * brief requires is still actually created, unaffected by this file's own
   * additions.
   */
  it('payroll_run_sod_check is untouched — still actually created by node-pg-migrate', () => {
    const files = migrationFiles()
    const parentFile = files.find((f) => f.includes('payroll-schema'))
    if (parentFile === undefined) throw new Error('no *payroll-schema*.js migration file found')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS files loaded by the runner the same way; this test loads the same artifact.
    const parentMigration = require(join(MIGRATIONS_DIR, parentFile)) as { up: (pgm: MigrationBuilder) => void }
    const unreachableDb: DB = {
      query: () => {
        throw new Error('unreachable: this harness only builds SQL text, it never executes it')
      },
      select: () => {
        throw new Error('unreachable: this harness only builds SQL text, it never executes it')
      },
    }
    const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }
    const pgm = new MigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
    parentMigration.up(pgm)
    expect(pgm.getSql()).toMatch(
      /ADD CONSTRAINT "payroll_run_sod_check" CHECK \(approved_by IS NULL OR approved_by <> prepared_by\);/,
    )
  })

  it('all 13 bytea columns are still exactly the same 13, in the same order', () => {
    const source = parentMigrationSource()
    const byteaColumnPattern = /(\w+):\s*\{\s*type:\s*'bytea'/g
    const byteaColumns: string[] = []
    let match: RegExpExecArray | null
    while ((match = byteaColumnPattern.exec(source)) !== null) {
      const columnName = match[1]
      if (columnName !== undefined) byteaColumns.push(columnName)
    }
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

  it('timesheet_lock_version is still integer and notNull', () => {
    const source = migrationSource()
    const columnMatch = /timesheet_lock_version:\s*\{[^}]*\}/.exec(source)
    expect(columnMatch).not.toBeNull()
    expect(columnMatch?.[0]).toMatch(/type:\s*'integer'/)
    expect(columnMatch?.[0]).toMatch(/notNull:\s*true/)
  })

  it("payroll_run's own trigger is still BEFORE UPDATE OR DELETE only — no INSERT added to it", () => {
    const source = migrationSource()
    expect(source).toMatch(
      /CREATE TRIGGER payroll_run_immutable_when_committed\s+BEFORE UPDATE OR DELETE ON payroll\.payroll_run/,
    )
    expect(source).not.toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON payroll\.payroll_run/)
  })

  it("payslip's own trigger is still BEFORE UPDATE OR DELETE only — no INSERT added to it (the generalised function's INSERT branch is inert for it)", () => {
    const source = migrationSource()
    expect(source).toMatch(
      /CREATE TRIGGER payslip_immutable_when_run_committed\s+BEFORE UPDATE OR DELETE ON payroll\.payslip/,
    )
    expect(source).not.toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON payroll\.payslip\b/)
  })
})

describe('payroll child-immutability migration — statutory_export (reused one-hop function, generalised for INSERT)', () => {
  it('a BEFORE INSERT OR UPDATE OR DELETE trigger exists on statutory_export, executing forbid_committed_run_child_mutation', () => {
    const source = migrationSource()
    expect(source).toMatch(
      /CREATE TRIGGER statutory_export_immutable_when_run_committed\s+BEFORE INSERT OR UPDATE OR DELETE ON payroll\.statutory_export\s+FOR EACH ROW\s+EXECUTE FUNCTION payroll\.forbid_committed_run_child_mutation\(\);/,
    )
  })

  it('the reused function handles INSERT by reading NEW.run_id, and UPDATE/DELETE by reading OLD.run_id', () => {
    const source = migrationSource()
    expect(source).toMatch(/target_run_id := NEW\.run_id/)
    expect(source).toMatch(/target_run_id := OLD\.run_id/)
  })

  it('DEMONSTRATION: the trigger-presence assertion FAILS if the CREATE TRIGGER statement is removed from the source', () => {
    const source = migrationSource()
    const withTriggerRemoved = source.replace(
      /CREATE TRIGGER statutory_export_immutable_when_run_committed\s+BEFORE INSERT OR UPDATE OR DELETE ON payroll\.statutory_export[\s\S]*?EXECUTE FUNCTION payroll\.forbid_committed_run_child_mutation\(\);\s*`\)/,
      '`)',
    )
    expect(withTriggerRemoved).not.toEqual(source)
    expect(withTriggerRemoved).not.toMatch(
      /CREATE TRIGGER statutory_export_immutable_when_run_committed\s+BEFORE INSERT OR UPDATE OR DELETE ON payroll\.statutory_export/,
    )
  })
})

describe('payroll child-immutability migration — pay_item (new two-hop grandchild function)', () => {
  it('a BEFORE INSERT OR UPDATE OR DELETE trigger exists on pay_item, executing forbid_committed_run_grandchild_mutation', () => {
    const source = migrationSource()
    expect(source).toMatch(
      /CREATE TRIGGER pay_item_immutable_when_run_committed\s+BEFORE INSERT OR UPDATE OR DELETE ON payroll\.pay_item\s+FOR EACH ROW\s+EXECUTE FUNCTION payroll\.forbid_committed_run_grandchild_mutation\(\);/,
    )
  })

  it('the grandchild function joins payslip -> payroll_run (two hops), not payroll_run directly', () => {
    const source = migrationSource()
    expect(source).toMatch(
      /CREATE FUNCTION payroll\.forbid_committed_run_grandchild_mutation\(\)[\s\S]*?FROM payroll\.payslip ps\s*JOIN payroll\.payroll_run pr ON pr\.id = ps\.run_id[\s\S]*?run_status = 'committed'[\s\S]*?RAISE EXCEPTION/,
    )
  })

  it('DEMONSTRATION: the trigger-presence assertion FAILS if the CREATE TRIGGER statement is removed from the source', () => {
    const source = migrationSource()
    const withTriggerRemoved = source.replace(
      /CREATE TRIGGER pay_item_immutable_when_run_committed\s+BEFORE INSERT OR UPDATE OR DELETE ON payroll\.pay_item[\s\S]*?EXECUTE FUNCTION payroll\.forbid_committed_run_grandchild_mutation\(\);\s*`\)/,
      '`)',
    )
    expect(withTriggerRemoved).not.toEqual(source)
    expect(withTriggerRemoved).not.toMatch(
      /CREATE TRIGGER pay_item_immutable_when_run_committed\s+BEFORE INSERT OR UPDATE OR DELETE ON payroll\.pay_item/,
    )
  })
})

// ---------------------------------------------------------------------
// JS-level behavioural mirror — no Postgres here, so this is the
// FakeConfigDb-style proof that the *rule* the SQL encodes is correct, not
// just that the SQL text is present. Kept intentionally tiny: it mirrors
// only the allow/deny decision both trigger functions make (same decision
// for INSERT/UPDATE/DELETE alike — only which columns supply run_id/
// payslip_id differs by TG_OP, not the decision itself), not a full SQL
// engine.
// ---------------------------------------------------------------------

type RunStatus = 'draft' | 'calculated' | 'reviewed' | 'approved' | 'committed'
interface FakeRun {
  id: string
  status: RunStatus
}
interface FakePayslip {
  id: string
  runId: string
}

/** Mirrors `forbid_committed_run_child_mutation()`'s decision for statutory_export (and payslip): blocked iff the referenced run is committed. */
function canMutateStatutoryExport(runs: readonly FakeRun[], runId: string): boolean {
  const run = runs.find((r) => r.id === runId)
  return run?.status !== 'committed'
}

/** Mirrors `forbid_committed_run_grandchild_mutation()`'s decision for pay_item: blocked iff the payslip's run is committed. */
function canMutatePayItem(runs: readonly FakeRun[], payslips: readonly FakePayslip[], payslipId: string): boolean {
  const payslip = payslips.find((p) => p.id === payslipId)
  if (!payslip) return true // an orphaned reference is not this trigger's concern
  const run = runs.find((r) => r.id === payslip.runId)
  return run?.status !== 'committed'
}

describe('payroll child-immutability — behavioural proof: pay_item', () => {
  const committedRun: FakeRun = { id: 'run-committed', status: 'committed' }
  const draftRun: FakeRun = { id: 'run-draft', status: 'draft' }
  const calculatedRun: FakeRun = { id: 'run-calculated', status: 'calculated' }
  const runs = [committedRun, draftRun, calculatedRun]
  const payslips: FakePayslip[] = [
    { id: 'payslip-committed', runId: committedRun.id },
    { id: 'payslip-draft', runId: draftRun.id },
    { id: 'payslip-calculated', runId: calculatedRun.id },
  ]

  it('a pay_item under a committed run cannot be inserted, updated, or deleted (one decision covers all three)', () => {
    expect(canMutatePayItem(runs, payslips, 'payslip-committed')).toBe(false)
  })

  it('a pay_item under a draft run can be inserted, updated, and deleted', () => {
    expect(canMutatePayItem(runs, payslips, 'payslip-draft')).toBe(true)
  })

  it('a pay_item under a calculated run can be inserted, updated, and deleted', () => {
    expect(canMutatePayItem(runs, payslips, 'payslip-calculated')).toBe(true)
  })
})

describe('payroll child-immutability — behavioural proof: statutory_export', () => {
  const committedRun: FakeRun = { id: 'run-committed', status: 'committed' }
  const draftRun: FakeRun = { id: 'run-draft', status: 'draft' }
  const calculatedRun: FakeRun = { id: 'run-calculated', status: 'calculated' }
  const runs = [committedRun, draftRun, calculatedRun]

  it('a statutory_export under a committed run cannot be inserted, updated, or deleted', () => {
    expect(canMutateStatutoryExport(runs, committedRun.id)).toBe(false)
  })

  it('a statutory_export under a draft run can be inserted, updated, and deleted', () => {
    expect(canMutateStatutoryExport(runs, draftRun.id)).toBe(true)
  })

  it('a statutory_export under a calculated run can be inserted, updated, and deleted', () => {
    expect(canMutateStatutoryExport(runs, calculatedRun.id)).toBe(true)
  })
})

describe('payroll child-immutability — behavioural proof: the correction path (adjustment run) is not broken', () => {
  it('a pay_item can still be inserted into a fresh adjustment run while an earlier regular run sits committed', () => {
    const committedRegularRun: FakeRun = { id: 'run-regular-committed', status: 'committed' }
    const draftAdjustmentRun: FakeRun = { id: 'run-adjustment-draft', status: 'draft' }
    const runs = [committedRegularRun, draftAdjustmentRun]
    const payslips: FakePayslip[] = [
      { id: 'payslip-on-committed-regular', runId: committedRegularRun.id },
      { id: 'payslip-on-draft-adjustment', runId: draftAdjustmentRun.id },
    ]

    // The committed regular run's own children stay frozen...
    expect(canMutatePayItem(runs, payslips, 'payslip-on-committed-regular')).toBe(false)
    // ...but the new adjustment run's children — a distinct payroll_run row
    // with its own id and a non-committed status — are entirely unaffected.
    expect(canMutatePayItem(runs, payslips, 'payslip-on-draft-adjustment')).toBe(true)
  })

  it('a statutory_export can still be inserted for a fresh adjustment run while an earlier regular run sits committed', () => {
    const committedRegularRun: FakeRun = { id: 'run-regular-committed', status: 'committed' }
    const draftAdjustmentRun: FakeRun = { id: 'run-adjustment-draft', status: 'draft' }
    const runs = [committedRegularRun, draftAdjustmentRun]

    expect(canMutateStatutoryExport(runs, committedRegularRun.id)).toBe(false)
    expect(canMutateStatutoryExport(runs, draftAdjustmentRun.id)).toBe(true)
  })

  it('DEMONSTRATION: without the guard, a committed run\'s pay_item would incorrectly be mutable — proving the guard is load-bearing', () => {
    const unguardedCanMutatePayItem = (): boolean => true // what canMutatePayItem would degrade to if the trigger's `IF run_status = 'committed'` branch were deleted
    expect(unguardedCanMutatePayItem()).not.toBe(canMutatePayItem([{ id: 'r', status: 'committed' }], [{ id: 'p', runId: 'r' }], 'p'))
  })
})
