import { GadongError } from '@gadong/kernel'
import { RulesRepository } from './rules.repository'
import type { NewRuleRow } from './rules.repository'
import { RulesService } from './rules.service'
import { FakeConfigDb } from './testing/fake-db'

function seedRow(overrides: Partial<NewRuleRow> = {}): NewRuleRow {
  return {
    ruleKey: 'leave.annual.min_days',
    value: 6,
    unit: 'days',
    statutoryFloor: 6,
    statutoryCeiling: null,
    citation: 'LPA s.30',
    effectiveFrom: '1998-08-19',
    effectiveTo: null,
    governanceClass: 'STATUTORY_FLOOR',
    status: 'active',
    proposedBy: null,
    approvedBy: null,
    reason: null,
    ...overrides,
  }
}

function makeService(now = () => new Date('2026-08-02T00:00:00Z')): { service: RulesService; repo: RulesRepository; db: FakeConfigDb } {
  const db = new FakeConfigDb()
  const conn = db.connect()
  const repo = new RulesRepository(conn)
  return { service: new RulesService(repo, now), repo, db }
}

describe('RulesService.propose — floor validation (the compliance claim)', () => {
  it('CFG-422 rejects leave.annual.min_days proposed at 4 when the floor is 6, and the response carries the citation "LPA s.30"', async () => {
    const { service, db } = makeService()
    const conn = db.connect()

    await expect(
      service.propose(conn, {
        ruleKey: 'leave.annual.min_days',
        value: 4,
        unit: 'days',
        statutoryFloor: 6,
        citation: 'LPA s.30',
        effectiveFrom: '2027-01-01',
        governanceClass: 'STATUTORY_FLOOR',
        reason: 'cost cutting',
        proposedBy: 'hr-admin-1',
      }),
    ).rejects.toMatchObject({
      code: 'CFG-422',
      details: [expect.objectContaining({ citation: 'LPA s.30' })],
    })
  })

  it('accepts leave.annual.min_days proposed at 8 (above the floor — companies may exceed)', async () => {
    const { service, db } = makeService()
    const conn = db.connect()

    const row = await service.propose(conn, {
      ruleKey: 'leave.annual.min_days',
      value: 8,
      unit: 'days',
      statutoryFloor: 6,
      citation: 'LPA s.30',
      effectiveFrom: '2027-01-01',
      governanceClass: 'STATUTORY_FLOOR',
      reason: 'generous policy',
      proposedBy: 'hr-admin-1',
    })

    expect(row).toMatchObject({ value: 8, status: 'draft' })
  })

  it('emits audit.rule.proposed with the actor, ruleKey and governanceClass — never the proposed value in the clear (roadmap: "governance actions on statutory data")', async () => {
    const { service, db } = makeService()
    const conn = db.connect()

    const row = await service.propose(conn, {
      ruleKey: 'leave.annual.min_days',
      value: 8,
      unit: 'days',
      statutoryFloor: 6,
      citation: 'LPA s.30',
      effectiveFrom: '2027-01-01',
      governanceClass: 'STATUTORY_FLOOR',
      reason: 'generous policy',
      proposedBy: 'hr-admin-1',
      proposedByRole: 'hr_admin',
    })

    const [audit] = db.debugOutboxRows().filter((r) => r.topic === 'audit.rule.proposed')
    expect(audit?.payload).toMatchObject({
      actorId: 'hr-admin-1',
      actorRole: 'hr_admin',
      action: 'rule.proposed',
      entity: 'statutory_rule',
      entityId: row.id,
      beforeHash: null,
    })
    expect((audit?.payload as Record<string, unknown>)['afterHash']).toEqual(expect.any(String))
  })

  it('a rejected proposal (below the statutory floor) emits NO audit entry — nothing was actually written', async () => {
    const { service, db } = makeService()
    const conn = db.connect()

    await expect(
      service.propose(conn, {
        ruleKey: 'leave.annual.min_days',
        value: 4,
        unit: 'days',
        statutoryFloor: 6,
        citation: 'LPA s.30',
        effectiveFrom: '2027-01-01',
        governanceClass: 'STATUTORY_FLOOR',
        reason: 'x',
        proposedBy: 'hr-admin-1',
      }),
    ).rejects.toMatchObject({ code: 'CFG-422' })

    expect(db.debugOutboxRows()).toHaveLength(0)
  })

  it('CFG-422 also rejects a value above a statutory ceiling, citing the same rule', async () => {
    const { service, db } = makeService()
    const conn = db.connect()

    await expect(
      service.propose(conn, {
        ruleKey: 'hours.regular.max_per_day',
        value: 10,
        unit: 'hours',
        statutoryCeiling: 8,
        citation: 'LPA s.23',
        effectiveFrom: '2027-01-01',
        governanceClass: 'STATUTORY_FLOOR',
        reason: 'extended hours pilot',
        proposedBy: 'hr-admin-1',
      }),
    ).rejects.toMatchObject({ code: 'CFG-422', details: [expect.objectContaining({ citation: 'LPA s.23' })] })
  })
})

describe('RulesService.propose — STATUTORY_FIXED is not hand-editable', () => {
  it('CFG-403 rejects a POST /rules proposal for an existing STATUTORY_FIXED key (sso.rate.employee)', async () => {
    const { service, repo, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await repo.insert(
      conn,
      seedRow({
        ruleKey: 'sso.rate.employee',
        value: 0.05,
        unit: 'percent',
        statutoryFloor: null,
        citation: 'SSA',
        effectiveFrom: '1990-01-01',
        governanceClass: 'STATUTORY_FIXED',
      }),
    )
    await conn.query('COMMIT')

    await expect(
      service.propose(conn, {
        ruleKey: 'sso.rate.employee',
        value: 0.06,
        unit: 'percent',
        citation: 'SSA',
        effectiveFrom: '2027-01-01',
        governanceClass: 'STATUTORY_FIXED',
        reason: 'attempted hand edit',
        proposedBy: 'hr-admin-1',
      }),
    ).rejects.toMatchObject({ code: 'CFG-403' })
  })

  it('CFG-403 also rejects a brand-new key proposed directly as STATUTORY_FIXED', async () => {
    const { service, db } = makeService()
    const conn = db.connect()

    await expect(
      service.propose(conn, {
        ruleKey: 'pit.bracket.09',
        value: { min: 0, max: 1, rate: 0 },
        unit: 'percent',
        citation: 'Revenue Code',
        effectiveFrom: '2027-01-01',
        governanceClass: 'STATUTORY_FIXED',
        reason: 'attempted hand edit of a new fixed rule',
        proposedBy: 'hr-admin-1',
      }),
    ).rejects.toMatchObject({ code: 'CFG-403' })
  })
})

describe('RulesService.approve — segregation of duties (service-layer check)', () => {
  it('AUZ-409 rejects approving your own proposal', async () => {
    const { service, repo, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    const proposed = await repo.insert(conn, seedRow({ status: 'draft', proposedBy: 'hr-admin-1', approvedBy: null }))
    await conn.query('COMMIT')

    await expect(service.approve(conn, proposed.id, 'hr-admin-1')).rejects.toMatchObject({ code: 'AUZ-409' })
  })

  it('activates the rule when the approver differs from the proposer, and publishes rules.updated AND audit.rule.approved to the outbox in the same transaction', async () => {
    const { service, repo, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    const proposed = await repo.insert(conn, seedRow({ status: 'draft', proposedBy: 'hr-admin-1', approvedBy: null }))
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    const approved = await service.approve(conn, proposed.id, 'compliance-approver-1', 'compliance_officer')
    await conn.query('COMMIT')

    expect(approved).toMatchObject({ status: 'active', approvedBy: 'compliance-approver-1' })
    const outboxRows = db.debugOutboxRows()
    expect(outboxRows).toHaveLength(2)
    expect(outboxRows[0]).toMatchObject({
      topic: 'rules.updated',
      payload: { ruleKeys: ['leave.annual.min_days'], effectiveFrom: '1998-08-19' },
    })
    expect(outboxRows[1]).toMatchObject({
      topic: 'audit.rule.approved',
      payload: {
        actorId: 'compliance-approver-1',
        actorRole: 'compliance_officer',
        action: 'rule.approved',
        entity: 'statutory_rule',
        entityId: proposed.id,
        beforeHash: null,
      },
    })
  })

  it('a rolled-back approve() does not publish rules.updated — the status change and the outbox row commit or roll back together', async () => {
    const { service, repo, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    const proposed = await repo.insert(conn, seedRow({ status: 'draft', proposedBy: 'hr-admin-1', approvedBy: null }))
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    await service.approve(conn, proposed.id, 'compliance-approver-1')
    await conn.query('ROLLBACK')

    expect(db.debugOutboxRows()).toHaveLength(0)
    expect(db.debugRules().find((r) => r.id === proposed.id)?.status).toBe('draft')
  })
})

describe('RulesService.getEffective — effective dating (PRD M7-2, the binding acceptance test)', () => {
  it('EWF: a September 2026 date has no effective row (404); an October 2026 date resolves to 0.25%, with no code change — only effective-dated config', async () => {
    const { service, repo, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await repo.insert(
      conn,
      seedRow({
        ruleKey: 'ewf.rate.employee',
        value: 0.0025,
        unit: 'percent',
        statutoryFloor: null,
        citation: 'Cabinet-approved deferral from 1 Oct 2025',
        effectiveFrom: '2026-10-01',
        effectiveTo: '2031-09-30',
        governanceClass: 'STATUTORY_FIXED',
      }),
    )
    await repo.insert(
      conn,
      seedRow({
        ruleKey: 'ewf.rate.employee',
        value: 0.005,
        unit: 'percent',
        statutoryFloor: null,
        citation: 'Cabinet-approved deferral from 1 Oct 2025',
        effectiveFrom: '2031-10-01',
        effectiveTo: null,
        governanceClass: 'STATUTORY_FIXED',
      }),
    )
    await conn.query('COMMIT')

    await expect(service.getEffective('ewf.rate.employee', '2026-09-30')).rejects.toMatchObject({ code: 'CFG-404' })
    const october = await service.getEffective('ewf.rate.employee', '2026-10-01')
    expect(october.value).toBe(0.0025)
  })

  it('sso.wage.ceiling: 15000 resolves through 2025-12-31; 17500 resolves from 2026-01-01', async () => {
    const { service, repo, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await repo.insert(
      conn,
      seedRow({
        ruleKey: 'sso.wage.ceiling',
        value: 15000,
        unit: 'THB',
        statutoryFloor: null,
        citation: 'SSA',
        effectiveFrom: '1990-01-01',
        effectiveTo: '2025-12-31',
        governanceClass: 'STATUTORY_FIXED',
      }),
    )
    await repo.insert(
      conn,
      seedRow({
        ruleKey: 'sso.wage.ceiling',
        value: 17500,
        unit: 'THB',
        statutoryFloor: null,
        citation: 'Ceiling increase effective 1 Jan 2026',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        governanceClass: 'STATUTORY_FIXED',
      }),
    )
    await conn.query('COMMIT')

    const before = await service.getEffective('sso.wage.ceiling', '2025-12-31')
    expect(before.value).toBe(15000)
    const after = await service.getEffective('sso.wage.ceiling', '2026-01-01')
    expect(after.value).toBe(17500)
  })

  it('defaults `on` to today when not supplied', async () => {
    const { service, repo, db } = makeService(() => new Date('2026-11-15T00:00:00Z'))
    const conn = db.connect()
    await conn.query('BEGIN')
    await repo.insert(
      conn,
      seedRow({
        ruleKey: 'ewf.rate.employee',
        value: 0.0025,
        statutoryFloor: null,
        effectiveFrom: '2026-10-01',
        effectiveTo: '2031-09-30',
        governanceClass: 'STATUTORY_FIXED',
      }),
    )
    await conn.query('COMMIT')

    const resolved = await service.getEffective('ewf.rate.employee')
    expect(resolved.value).toBe(0.0025)
  })

  it('404s with GadongError when no version has ever existed for the key', async () => {
    const { service } = makeService()
    await expect(service.getEffective('no.such.rule')).rejects.toBeInstanceOf(GadongError)
  })
})

describe('RulesService.listCurrent', () => {
  it('returns the current-effective row per distinct key under a prefix, sorted by key', async () => {
    const { service, repo, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await repo.insert(conn, seedRow({ ruleKey: 'leave.sick.paid_days', value: 30, statutoryFloor: 30 }))
    await repo.insert(conn, seedRow({ ruleKey: 'leave.annual.min_days', value: 6, statutoryFloor: 6 }))
    await repo.insert(conn, seedRow({ ruleKey: 'sso.rate.employee', value: 0.05, statutoryFloor: null, governanceClass: 'STATUTORY_FIXED' }))
    await conn.query('COMMIT')

    const rows = await service.listCurrent('leave.')

    expect(rows.map((r) => r.ruleKey)).toEqual(['leave.annual.min_days', 'leave.sick.paid_days'])
  })
})
