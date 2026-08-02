import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Proves the migration's SQL text directly — no database available in this
 * environment (Task 9 brief CONSTRAINTS) — for the two properties the Task
 * 9 brief calls "the point": the `audit` DB role never receives UPDATE or
 * DELETE on either table, and no `outbox` table exists in this schema at
 * all (this service consumes events, it never publishes any).
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migrationSource(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
  if (files.length === 0) throw new Error(`no migration files found in ${MIGRATIONS_DIR}`)
  return files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).join('\n')
}

/** Every `GRANT <privileges> ON <table> TO audit` statement's privilege list, split and normalised. */
function grantsToAuditRole(source: string): Array<{ table: string; privileges: string[] }> {
  const grants: Array<{ table: string; privileges: string[] }> = []
  const pattern = /GRANT\s+([^;]+?)\s+ON\s+(\S+)\s+TO\s+audit\s*;/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const privilegeList = match[1]
    const table = match[2]
    if (privilegeList === undefined || table === undefined) continue
    grants.push({
      table,
      privileges: privilegeList.split(',').map((p) => p.trim().toUpperCase()),
    })
  }
  return grants
}

describe('audit schema migration — append-only grants', () => {
  it('grants the audit role only SELECT and/or INSERT on audit.entry — never UPDATE, DELETE, TRUNCATE, or ALL', () => {
    const source = migrationSource()
    const grants = grantsToAuditRole(source)
    const entryGrants = grants.filter((g) => g.table === 'audit.entry')

    expect(entryGrants.length).toBeGreaterThan(0)
    for (const grant of entryGrants) {
      for (const privilege of grant.privileges) {
        expect(['SELECT', 'INSERT']).toContain(privilege)
      }
    }
  })

  it('grants the audit role only SELECT and/or INSERT on audit.processed_events — never UPDATE, DELETE, TRUNCATE, or ALL', () => {
    const source = migrationSource()
    const grants = grantsToAuditRole(source)
    const processedEventsGrants = grants.filter((g) => g.table === 'audit.processed_events')

    expect(processedEventsGrants.length).toBeGreaterThan(0)
    for (const grant of processedEventsGrants) {
      for (const privilege of grant.privileges) {
        expect(['SELECT', 'INSERT']).toContain(privilege)
      }
    }
  })

  it('never grants ALL PRIVILEGES (or any spelling of ALL) to the audit role on any table', () => {
    const source = migrationSource()
    expect(/GRANT\s+ALL[\s\S]*?TO\s+audit\b/i.test(source)).toBe(false)
  })

  it('the migration text never mentions granting UPDATE or DELETE to the audit role, anywhere', () => {
    const source = migrationSource()
    // Scoped to statements that grant TO audit specifically, not a blanket
    // ban on the words UPDATE/DELETE anywhere in the file (comments are
    // free to discuss them, as this file's own prose does).
    const grantToAuditStatements = source.match(/GRANT[^;]*TO\s+audit\s*;/gi) ?? []
    for (const statement of grantToAuditStatements) {
      expect(statement.toUpperCase()).not.toMatch(/\bUPDATE\b/)
      expect(statement.toUpperCase()).not.toMatch(/\bDELETE\b/)
    }
  })

  it('explicitly revokes all privileges from the audit role before granting SELECT/INSERT — the absence of UPDATE/DELETE is a written statement, not merely never having been granted', () => {
    const source = migrationSource()
    expect(source).toMatch(/REVOKE ALL ON audit\.entry FROM audit\s*;/)
    expect(source).toMatch(/REVOKE ALL ON audit\.processed_events FROM audit\s*;/)
  })

  it('creates no outbox table — this service consumes audit.* events, it never publishes any', () => {
    const source = migrationSource()
    // Scoped to an actual `pgm.createTable` call site, not a blanket ban on
    // the word "outbox" anywhere in the file — this migration's own doc
    // comments discuss, in prose, why there is deliberately no such table.
    expect(/name:\s*['"]outbox['"]/i.test(source)).toBe(false)
  })

  it('creates audit.entry with every column the Task 9 brief specifies', () => {
    const source = migrationSource()
    for (const column of [
      'id',
      'occurred_at',
      'actor_id',
      'actor_role',
      'action',
      'entity',
      'entity_id',
      'purpose',
      'before_hash',
      'after_hash',
      'prev_entry_hash',
      'entry_hash',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\s*:`))
    }
  })

  it('creates audit.processed_events with event_id as its primary key', () => {
    const source = migrationSource()
    expect(source).toMatch(/name:\s*['"]processed_events['"][\s\S]{0,300}event_id[\s\S]{0,100}primaryKey:\s*true/)
  })
})
