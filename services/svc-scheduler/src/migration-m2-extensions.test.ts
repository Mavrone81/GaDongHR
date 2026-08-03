import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Same harness as `migration.test.ts` (Task 14), scoped to the M2
 * extensions migration (`1754400100000_scheduler-m2-extensions.js`): real
 * SQL text out of a real `MigrationBuilderImpl`, never a database (no
 * Postgres in this environment) and never a bare source-text scan for
 * anything constraint-shaped (Task 16c: `{ constraints: {...} }` used to be
 * silently ignored by node-pg-migrate and only running the real builder
 * catches that class of defect).
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

interface ExtensionsMigrationModule {
  up: (pgm: MigrationBuilder) => void
  down: (pgm: MigrationBuilder) => void
}

function loadExtensionsMigration(): ExtensionsMigrationModule {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  const file = files.find((f) => f.includes('m2-extensions'))
  if (file === undefined) throw new Error('no *m2-extensions*.js migration file found')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded the same way node-pg-migrate's runner loads it.
  return require(join(MIGRATIONS_DIR, file)) as ExtensionsMigrationModule
}

function extensionsSource(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js') && f.includes('m2-extensions'))
  if (files.length !== 1) throw new Error(`expected exactly one m2-extensions migration file, found ${files.length}`)
  const file = files[0]
  if (file === undefined) throw new Error('unreachable')
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
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

describe('scheduler m2-extensions migration — roster_entry.hazardous', () => {
  it('adds hazardous as a not-null boolean defaulting false', () => {
    const sql = buildSql(loadExtensionsMigration().up)
    expect(sql).toMatch(/ALTER TABLE "scheduler"\."roster_entry"\s+ADD "hazardous" boolean DEFAULT false NOT NULL/)
  })
})

describe('scheduler m2-extensions migration — ot_request consent/reason fields', () => {
  it('adds reason (not null), employee_consent (not null boolean), and decision_reason (nullable)', () => {
    const sql = buildSql(loadExtensionsMigration().up)
    expect(sql).toMatch(/ADD "reason" text DEFAULT \$pga\$\$pga\$ NOT NULL/)
    expect(sql).toMatch(/ADD "employee_consent" boolean DEFAULT false NOT NULL/)
    expect(sql).toMatch(/ADD "decision_reason" text;/)
    expect(sql).not.toMatch(/"decision_reason" text NOT NULL/)
  })
})

describe('scheduler m2-extensions migration — scheduler_employee_ref.org_unit_id', () => {
  it('adds a nullable org_unit_id uuid column', () => {
    const sql = buildSql(loadExtensionsMigration().up)
    expect(sql).toMatch(/ALTER TABLE "scheduler"\."scheduler_employee_ref"\s+ADD "org_unit_id" uuid/)
  })
})

describe('scheduler m2-extensions migration — leave_ref (LeaveReadModel)', () => {
  it('creates leave_ref with employee_id, leave_request_id, date_from, date_to, status', () => {
    const source = extensionsSource()
    expect(source).toMatch(/employee_id:\s*\{\s*type:\s*'uuid',\s*notNull:\s*true\s*\}/)
    expect(source).toMatch(/leave_request_id:\s*\{\s*type:\s*'text',\s*notNull:\s*true\s*\}/)
    expect(source).toMatch(/date_from:\s*\{\s*type:\s*'date'/)
    expect(source).toMatch(/date_to:\s*\{\s*type:\s*'date'/)
  })

  it('does not declare a references clause on employee_id — same no-FK reasoning as roster_entry/ot_request', () => {
    const source = extensionsSource()
    const block = source.slice(source.indexOf("name: 'leave_ref' }"), source.indexOf('leave_ref_leave_request_id_key'))
    const employeeIdField = block.slice(block.indexOf('employee_id:'), block.indexOf('leave_request_id:'))
    expect(employeeIdField).not.toMatch(/references/)
  })

  it('constrains leave_request_id to UNIQUE, actually created by node-pg-migrate', () => {
    const sql = buildSql(loadExtensionsMigration().up)
    expect(sql).toMatch(/ADD CONSTRAINT "leave_ref_leave_request_id_key" UNIQUE \("leave_request_id"\);/)
  })

  it('constrains status to approved|cancelled, actually created by node-pg-migrate', () => {
    const sql = buildSql(loadExtensionsMigration().up)
    expect(sql).toMatch(/ADD CONSTRAINT "leave_ref_status_check" CHECK \(status IN \('approved', 'cancelled'\)\);/)
  })

  it('never mentions the onboarding or leave schema anywhere — no cross-schema FK', () => {
    const source = extensionsSource()
    expect(source).not.toMatch(/onboarding/)
    expect(source).not.toMatch(/schema:\s*'leave'/)
  })
})

describe('scheduler m2-extensions migration — down() is a clean, additive-only teardown', () => {
  it('drops leave_ref and the added columns, nothing else', () => {
    const sql = buildSql(loadExtensionsMigration().down)
    expect(sql).toMatch(/DROP TABLE "scheduler"\."leave_ref"/)
    expect(sql).toMatch(/ALTER TABLE "scheduler"\."scheduler_employee_ref"[\s\S]*DROP "org_unit_id"/)
    expect(sql).toMatch(/ALTER TABLE "scheduler"\."ot_request"[\s\S]*DROP "reason"/)
    expect(sql).toMatch(/ALTER TABLE "scheduler"\."roster_entry"[\s\S]*DROP "hazardous"/)
  })
})
