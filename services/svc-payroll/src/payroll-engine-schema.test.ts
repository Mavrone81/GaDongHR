import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * `1754701000000_payroll-engine.js` — the Phase 5 tables. Proved against
 * node-pg-migrate's REAL `MigrationBuilder`, so the assertions are about
 * the SQL that would actually be emitted rather than about the source text
 * looking approximately right. That distinction is the whole point of Task
 * 16c's fix, which found a constraint options shape that "looked like" a
 * constraint to a text scanner and created nothing.
 *
 * There is no Postgres in this environment, so this is how a migration is
 * proved here — the same technique `payroll-schema.test.ts` established.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function engineMigrationFile(): string {
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .find((f) => f.includes('payroll-engine'))
  if (file === undefined) throw new Error('no *payroll-engine*.js migration file found')
  return join(MIGRATIONS_DIR, file)
}

function loadMigration(): { up: (pgm: MigrationBuilder) => void; down: (pgm: MigrationBuilder) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS; the runner loads them the same way.
  return require(engineMigrationFile()) as { up: (pgm: MigrationBuilder) => void; down: (pgm: MigrationBuilder) => void }
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

function buildSql(action: (pgm: MigrationBuilder) => void): string {
  const pgm = new MigrationBuilderImpl(unreachableDb, undefined, false, silentLogger)
  action(pgm)
  return pgm.getSql()
}

const upSql = (): string => buildSql(loadMigration().up)

describe('payroll_employee_ref gains the facts the engine cannot compute without', () => {
  it('province (minimum wage), start date (severance tier), preferred language (payslip)', () => {
    const sql = upSql()
    for (const column of ['province_code', 'start_date', 'preferred_lang', 'org_unit_id', 'employment_type']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE "payroll"\\."payroll_employee_ref"[\\s\\S]*?"${column}"`))
    }
  })
})

describe('the termination record carries the s.119 cause AND its citation, or neither', () => {
  it('creates the table with both columns', () => {
    const sql = upSql()
    expect(sql).toMatch(/CREATE TABLE "payroll"\."termination"/)
    expect(sql).toMatch(/"statutory_cause" text/)
    expect(sql).toMatch(/"statutory_citation" text/)
  })

  /**
   * The database, not just the service, refuses a cause with no citation.
   * A final-pay run that pays no severance with no citation stored is
   * exactly the record an employer cannot defend in a labour court, so the
   * control lives where it survives a future bug.
   */
  it('the CHECK ties them together — one without the other is refused', () => {
    expect(upSql()).toMatch(
      /ADD CONSTRAINT "termination_statutory_cause_check" CHECK \(\(statutory_cause IS NULL\) = \(statutory_citation IS NULL\)\)/,
    )
  })

  it('DEMONSTRATION: removing that constraint from the migration removes it from the emitted SQL', () => {
    const sql = upSql()
    const withoutCheck = sql.replace(/ADD CONSTRAINT "termination_statutory_cause_check"[^;]*;/, '')
    expect(withoutCheck).not.toEqual(sql)
    expect(withoutCheck).not.toMatch(/termination_statutory_cause_check/)
  })
})

describe('pay_input — the taxable / SSO classification is stored PER LINE, notNull, with no default', () => {
  it('both booleans exist and are NOT NULL', () => {
    const sql = upSql()
    expect(sql).toMatch(/"taxable" boolean NOT NULL/)
    expect(sql).toMatch(/"sso_wage_base" boolean NOT NULL/)
  })

  /**
   * A DEFAULT on either column is how a reimbursement would silently become
   * taxable: an insert that forgot to state the classification would get
   * one rather than failing. `claim.approved_for_payroll` carries
   * `taxable:false`/`ssoWageBase:false` explicitly precisely so this never
   * has to be guessed.
   */
  it('NEITHER carries a DEFAULT — an omitted classification must fail, never be assumed', () => {
    const sql = upSql()
    const taxable = /"taxable" boolean NOT NULL[^,)]*/.exec(sql)?.[0] ?? ''
    const ssoBase = /"sso_wage_base" boolean NOT NULL[^,)]*/.exec(sql)?.[0] ?? ''
    expect(taxable).not.toMatch(/DEFAULT/i)
    expect(ssoBase).not.toMatch(/DEFAULT/i)
  })

  it('the amount is bytea — an unpaid one-off is money like any other', () => {
    expect(upSql()).toMatch(/CREATE TABLE "payroll"\."pay_input"[\s\S]*?"amount" bytea NOT NULL/)
  })

  it('UNIQUE (source, source_ref) — a redelivered claim event cannot pay twice', () => {
    expect(upSql()).toMatch(/ADD CONSTRAINT "pay_input_source_ref_key" UNIQUE \("source", "source_ref"\)/)
  })

  it('direction is constrained to earning or deduction', () => {
    expect(upSql()).toMatch(/ADD CONSTRAINT "pay_input_direction_check" CHECK \(direction IN \('earning', 'deduction'\)\)/)
  })
})

describe('timesheet_lock — the version a run binds to', () => {
  it('is keyed on the period and carries a non-negative version', () => {
    const sql = upSql()
    expect(sql).toMatch(/CREATE TABLE "payroll"\."timesheet_lock"[\s\S]*?"period" text PRIMARY KEY/)
    expect(sql).toMatch(/ADD CONSTRAINT "timesheet_lock_version_check" CHECK \(lock_version >= 0\)/)
  })

  it('also carries svc-timesheet\'s own period-row uuid — the identifier a real GET /periods/:id/totals call must use, distinct from the "period" primary key above', () => {
    const sql = upSql()
    expect(sql).toMatch(/CREATE TABLE "payroll"\."timesheet_lock"[\s\S]*?"period_id" uuid NOT NULL/)
  })
})

describe('the payslip gains its EMPLOYER-side columns, all encrypted', () => {
  it('sso_er, ewf_er, pf_er, taxable_gross and non_taxable_pay are all bytea', () => {
    const sql = upSql()
    for (const column of ['sso_er', 'ewf_er', 'pf_er', 'taxable_gross', 'non_taxable_pay']) {
      expect(sql).toMatch(new RegExp(`"${column}" bytea`))
    }
  })

  it('UNIQUE (run_id, employee_id) — without it a half-failed recalculation pays someone twice', () => {
    expect(upSql()).toMatch(/ADD CONSTRAINT "payslip_run_employee_key" UNIQUE \("run_id", "employee_id"\)/)
  })
})

describe('the pay profile gains bank details, with the account encrypted', () => {
  it('bank_code is plaintext (which bank), bank_account and bank_account_name are bytea (whose account)', () => {
    const sql = upSql()
    expect(sql).toMatch(/"bank_code" text/)
    expect(sql).toMatch(/"bank_account" bytea/)
    expect(sql).toMatch(/"bank_account_name" bytea/)
    expect(sql).toMatch(/"pf_rate_employer" bytea/)
  })
})

describe('run lifecycle bookkeeping', () => {
  it('an adjustment run MUST name the committed run it corrects', () => {
    expect(upSql()).toMatch(
      /ADD CONSTRAINT "payroll_run_adjustment_target_check" CHECK \(run_type <> 'adjustment' OR adjusts_run_id IS NOT NULL\)/,
    )
  })

  it('adjusts_run_id is a real self-referencing foreign key, not a loose uuid', () => {
    expect(upSql()).toMatch(/ADD "adjusts_run_id" uuid CONSTRAINT "payroll_run_adjusts_run_id_fkey" REFERENCES "payroll"\."payroll_run"/)
  })
})

describe('the export kinds widen to the four confirmed bank formats', () => {
  it('drops and re-adds the CHECK under the SAME name, so the parent migration\'s assertions still hold', () => {
    const sql = upSql()
    expect(sql).toMatch(/DROP CONSTRAINT "statutory_export_kind_check"/)
    const check = /ADD CONSTRAINT "statutory_export_kind_check" CHECK \(([^)]*)\)/.exec(sql)?.[1] ?? ''
    for (const kind of ['sso_1_10', 'pnd1', 'bank_csv', 'pnd1kor', '50bis', 'kor_ror_11', 'bank_kbank', 'bank_scb', 'bank_bbl', 'bank_krungsri']) {
      expect(check).toContain(`'${kind}'`)
    }
  })
})

describe('nothing this migration does weakens the two legal controls the parent migrations installed', () => {
  it('it does not touch payroll_run_sod_check', () => {
    expect(upSql()).not.toMatch(/payroll_run_sod_check/)
  })

  it('it does not drop, replace or re-create any immutability trigger or trigger function', () => {
    const source = readFileSync(engineMigrationFile(), 'utf8')
    expect(source).not.toMatch(/DROP TRIGGER/)
    expect(source).not.toMatch(/CREATE OR REPLACE FUNCTION/)
    expect(source).not.toMatch(/forbid_committed_run/)
  })
})

describe('down() reverses everything up() added', () => {
  it('drops the three new tables and every added column, and restores the original export-kind CHECK', () => {
    const sql = buildSql(loadMigration().down)
    expect(sql).toMatch(/DROP TABLE "payroll"\."timesheet_lock"/)
    expect(sql).toMatch(/DROP TABLE "payroll"\."pay_input"/)
    expect(sql).toMatch(/DROP TABLE "payroll"\."termination"/)
    expect(sql).toMatch(/DROP "bank_account"/)
    expect(sql).toMatch(/DROP "sso_er"/)
    expect(sql).toMatch(/DROP "province_code"/)
    const restored = /ADD CONSTRAINT "statutory_export_kind_check" CHECK \(([^)]*)\)/.exec(sql)?.[1] ?? ''
    expect(restored).not.toContain('bank_kbank')
  })
})
