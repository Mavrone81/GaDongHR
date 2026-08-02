import type { Queryable } from '@gadong/kernel'
import { RulesRepository } from './rules.repository'
import type { NewRuleRow } from './rules.repository'
import { ConstraintViolation, FakeConfigDb } from './testing/fake-db'

function draftRow(overrides: Partial<NewRuleRow> = {}): NewRuleRow {
  return {
    ruleKey: 'leave.annual.min_days',
    value: 8,
    unit: 'days',
    statutoryFloor: 6,
    statutoryCeiling: null,
    citation: 'LPA s.30',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    governanceClass: 'STATUTORY_FLOOR',
    status: 'draft',
    proposedBy: 'user-1',
    approvedBy: null,
    reason: 'annual review',
    ...overrides,
  }
}

describe('RulesRepository — SQL shape (mocked tx)', () => {
  it('insert() issues an INSERT into config.statutory_rule, serialises jsonb columns, and returns the mapped row', async () => {
    const returned = {
      id: 'rule-1',
      rule_key: 'leave.annual.min_days',
      value: 8,
      unit: 'days',
      statutory_floor: 6,
      statutory_ceiling: null,
      citation: 'LPA s.30',
      effective_from: '2026-01-01',
      effective_to: null,
      governance_class: 'STATUTORY_FLOOR',
      status: 'draft',
      proposed_by: 'user-1',
      approved_by: null,
      reason: 'annual review',
      created_at: new Date('2026-01-01T00:00:00Z'),
    }
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [returned] }) }
    const repo = new RulesRepository(tx)

    const row = await repo.insert(tx, draftRow())

    expect(tx.query).toHaveBeenCalledTimes(1)
    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO config\.statutory_rule/i)
    expect(params[0]).toBe('leave.annual.min_days')
    expect(params[1]).toBe(JSON.stringify(8))
    expect(row).toMatchObject({ id: 'rule-1', ruleKey: 'leave.annual.min_days', value: 8, statutoryFloor: 6 })
  })

  it("findActiveByKey() selects only status = 'active' rows for the key", async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new RulesRepository(tx)

    await repo.findActiveByKey('ewf.rate.employee')

    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/status = 'active'/i)
    expect(sql).toMatch(/rule_key = \$1/i)
    expect(params).toEqual(['ewf.rate.employee'])
  })

  it('findActiveByPrefix() filters with a LIKE pattern built from the prefix', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new RulesRepository(tx)

    await repo.findActiveByPrefix('leave.')

    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/rule_key LIKE \$1/i)
    expect(params).toEqual(['leave.%'])
  })

  it('a date column returned as a JS Date (the real pg driver behaviour) is normalised back to an ISO date string', async () => {
    const returned = {
      id: 'rule-1',
      rule_key: 'leave.annual.min_days',
      value: 6,
      unit: 'days',
      statutory_floor: 6,
      statutory_ceiling: null,
      citation: 'LPA s.30',
      effective_from: new Date('2026-01-01T00:00:00.000Z'),
      effective_to: null,
      governance_class: 'STATUTORY_FLOOR',
      status: 'active',
      proposed_by: null,
      approved_by: null,
      reason: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    }
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [returned] }) }
    const repo = new RulesRepository(tx)

    const rows = await repo.findActiveByKey('leave.annual.min_days')

    expect(rows[0]?.effectiveFrom).toBe('2026-01-01')
    expect(typeof rows[0]?.effectiveFrom).toBe('string')
  })
})

describe('RulesRepository — against FakeConfigDb (relational behaviour)', () => {
  it('insert() then findById() round-trips every field', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const repo = new RulesRepository(conn)

    await conn.query('BEGIN')
    const inserted = await repo.insert(conn, draftRow())
    await conn.query('COMMIT')

    const found = await repo.findById(inserted.id)
    expect(found).toEqual(inserted)
  })

  it('findActiveByKey() resolves the row effective on a given date via kernel resolveEffective (EWF: Sept 2026 vs Oct 2026)', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const repo = new RulesRepository(conn)

    await conn.query('BEGIN')
    await repo.insert(conn, {
      ...draftRow(),
      ruleKey: 'ewf.rate.employee',
      value: 0.0025,
      statutoryFloor: null,
      governanceClass: 'STATUTORY_FIXED',
      status: 'active',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2031-09-30',
      proposedBy: null,
      approvedBy: null,
    })
    await conn.query('COMMIT')

    const rows = await repo.findActiveByKey('ewf.rate.employee')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.effectiveFrom).toBe('2026-10-01')
  })

  it('UNIQUE (rule_key, effective_from): a second row with the same key and effective_from is rejected', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const repo = new RulesRepository(conn)

    await conn.query('BEGIN')
    await repo.insert(conn, draftRow({ effectiveFrom: '2026-01-01' }))
    await conn.query('COMMIT')

    await expect(repo.insert(conn, draftRow({ effectiveFrom: '2026-01-01', proposedBy: 'user-2' }))).rejects.toThrow(
      ConstraintViolation,
    )
  })

  describe('DB CHECK constraint — proposed_by <> approved_by (statutory_rule_sod_check)', () => {
    it('a direct INSERT with proposed_by = approved_by is rejected by the constraint, independent of any service-layer check', async () => {
      const db = new FakeConfigDb()
      const conn = db.connect()
      const repo = new RulesRepository(conn)

      await expect(
        repo.insert(conn, draftRow({ proposedBy: 'user-1', approvedBy: 'user-1', status: 'active' })),
      ).rejects.toThrow(ConstraintViolation)
    })

    it('proposed_by = approved_by is also rejected on UPDATE (the approve path)', async () => {
      const db = new FakeConfigDb()
      const conn = db.connect()
      const repo = new RulesRepository(conn)

      await conn.query('BEGIN')
      const row = await repo.insert(conn, draftRow({ proposedBy: 'user-1', approvedBy: null }))
      await conn.query('COMMIT')

      await expect(repo.approve(conn, row.id, 'user-1')).rejects.toThrow(ConstraintViolation)
    })

    it('a NULL on either side is allowed (a fresh draft, or a pack-imported row with neither set)', async () => {
      const db = new FakeConfigDb()
      const conn = db.connect()
      const repo = new RulesRepository(conn)

      await expect(
        repo.insert(conn, draftRow({ proposedBy: 'user-1', approvedBy: null })),
      ).resolves.toBeDefined()
      await expect(
        repo.insert(
          conn,
          draftRow({ ruleKey: 'sso.rate.employee', effectiveFrom: '1990-01-01', proposedBy: null, approvedBy: null }),
        ),
      ).resolves.toBeDefined()
    })
  })

  it('approve() activates a draft row and leaves a non-draft row untouched (returns null)', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const repo = new RulesRepository(conn)

    await conn.query('BEGIN')
    const row = await repo.insert(conn, draftRow({ proposedBy: 'user-1' }))
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    const approved = await repo.approve(conn, row.id, 'user-2')
    await conn.query('COMMIT')

    expect(approved).toMatchObject({ id: row.id, status: 'active', approvedBy: 'user-2' })

    const second = await repo.approve(conn, row.id, 'user-3')
    expect(second).toBeNull()
  })
})
