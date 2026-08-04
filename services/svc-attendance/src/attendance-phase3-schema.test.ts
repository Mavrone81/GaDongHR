import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MigrationBuilderImpl from 'node-pg-migrate/dist/migrationBuilder'
import type { DB, Logger, MigrationBuilder } from 'node-pg-migrate/dist/types'

/**
 * Same three-strategy approach as `attendance-schema.test.ts` (regex on
 * source text for column shape, a fake builder for structural determinism,
 * node-pg-migrate's real `MigrationBuilderImpl` for constraint-existence —
 * see that file's header for why strategy 3 is required for constraints).
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migrationFile(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  const file = files.find((f) => f.includes('attendance-phase3'))
  if (file === undefined) throw new Error('no *attendance-phase3*.js migration file found')
  return file
}

function migrationSource(): string {
  return readFileSync(join(MIGRATIONS_DIR, migrationFile()), 'utf8')
}

interface RealMigrationModule {
  up: (pgm: MigrationBuilder) => void
  down: (pgm: MigrationBuilder) => void
}

function loadRealMigration(): RealMigrationModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pg-migrate migrations are CommonJS, loaded the same way the runner loads them.
  return require(join(MIGRATIONS_DIR, migrationFile())) as RealMigrationModule
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

describe('attendance phase-3 migration — applies cleanly', () => {
  it('up runs against the real MigrationBuilder without throwing', () => {
    const migration = loadRealMigration()
    expect(() => buildSql(migration.up)).not.toThrow()
  })

  it('down runs against the real MigrationBuilder without throwing', () => {
    const migration = loadRealMigration()
    expect(() => buildSql(migration.down)).not.toThrow()
  })
})

describe('attendance phase-3 migration — no column can hold a face embedding', () => {
  it('the only bytea column this migration adds is alternative_credential.credential_hash — a keyed HMAC, never a raw code or an embedding', () => {
    const source = migrationSource()
    const byteaColumnPattern = /(\w+):\s*\{\s*type:\s*'bytea'/g
    const byteaColumns: string[] = []
    let match: RegExpExecArray | null
    while ((match = byteaColumnPattern.exec(source)) !== null) {
      const columnName = match[1]
      if (columnName !== undefined) byteaColumns.push(columnName)
    }
    expect(byteaColumns).toEqual(['credential_hash'])
  })

  it('no column anywhere in this migration is named anything embedding/template-shaped and binary', () => {
    const source = migrationSource()
    expect(source).not.toMatch(/(embedding|face_vector|biometric_data)\w*:\s*\{\s*type:\s*'bytea'/gi)
  })
})

describe('attendance phase-3 migration — biometric_consent (M4-1 enrolment gate)', () => {
  it('has a CHECK constraint restricting state to granted|withdrawn, actually created by node-pg-migrate', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "biometric_consent_state_check" CHECK \(state IN \('granted', 'withdrawn'\)\)/)
  })

  it('employee_id is the primary key — one current-consent-state row per employee', () => {
    const source = migrationSource()
    const block = /name:\s*['"]biometric_consent['"][\s\S]{0,300}/.exec(source)?.[0] ?? ''
    expect(block).toMatch(/employee_id:\s*\{\s*type:\s*'uuid',\s*primaryKey:\s*true/)
  })
})

describe('attendance phase-3 migration — alternative_credential (M4-5)', () => {
  it('credential_hash has a UNIQUE constraint, actually created by node-pg-migrate', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "alternative_credential_hash_key" UNIQUE \("credential_hash"\);/)
  })

  it('kind is restricted to pin|qr|badge, actually created by node-pg-migrate', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "alternative_credential_kind_check" CHECK \(kind IN \('pin', 'qr', 'badge'\)\)/)
  })
})

describe('attendance phase-3 migration — security_event (M4-3 liveness failure log)', () => {
  it('kind is restricted to liveness_failed|multi_face, actually created by node-pg-migrate', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "security_event_kind_check" CHECK \(kind IN \('liveness_failed', 'multi_face'\)\)/)
  })

  it('carries no image/frame column — only the fact that a check failed, never the pixels', () => {
    const source = migrationSource()
    const block = /name:\s*['"]security_event['"][\s\S]{0,500}/.exec(source)?.[0] ?? ''
    expect(block).not.toMatch(/frame|image/i)
  })
})

describe('attendance phase-3 migration — device second-person approval columns', () => {
  it('adds registered_by, approved_by, approved_at', () => {
    const source = migrationSource()
    for (const column of ['registered_by', 'approved_by', 'approved_at']) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('restricts device.status to pending|active|revoked, actually created by node-pg-migrate', () => {
    const migration = loadRealMigration()
    const sql = buildSql(migration.up)
    expect(sql).toMatch(/ADD CONSTRAINT "device_status_check" CHECK \(status IN \('pending', 'active', 'revoked'\)\)/)
  })
})
