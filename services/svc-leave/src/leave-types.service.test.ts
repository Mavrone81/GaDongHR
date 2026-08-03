import { randomUUID } from 'node:crypto'
import { GadongError } from '@gadong/kernel'
import { LeaveTypesRepository } from './leave-types.repository'
import { LeaveTypesService } from './leave-types.service'
import { FakeLeaveDb } from './testing/fake-db'
import { FakeConfigClient } from './testing/fake-config-client'

function setup() {
  const db = new FakeLeaveDb()
  const repo = new LeaveTypesRepository(db.asPool())
  const config = new FakeConfigClient()
  const service = new LeaveTypesService(repo, config, () => randomUUID())
  return { db, repo, config, service }
}

async function withTx<T>(db: FakeLeaveDb, fn: (tx: ReturnType<FakeLeaveDb['connect']>) => Promise<T>): Promise<T> {
  const conn = db.connect()
  await conn.query('BEGIN')
  try {
    const result = await fn(conn)
    await conn.query('COMMIT')
    return result
  } catch (err) {
    await conn.query('ROLLBACK')
    throw err
  }
}

describe('LeaveTypesService — statutory floor: annual leave (LPA s.30)', () => {
  it('creating at exactly the floor (6) succeeds', async () => {
    const { db, config, service } = setup()
    config.seed({
      ruleKey: 'leave.annual.min_days',
      value: 6,
      statutoryFloor: 6,
      citation: 'LPA s.30',
      effectiveFrom: '1998-08-19',
      effectiveTo: null,
    })
    const row = await withTx(db, (tx) =>
      service.create(tx, {
        code: 'annual',
        nameI18n: { en: 'Annual Leave' },
        payMode: 'full',
        accrualMode: 'annual_grant',
        statutoryRuleKey: 'leave.annual.min_days',
        entitlementDays: '6',
        carryOverEnabled: true,
      }),
    )
    expect(row.entitlementDays).toBe('6')
    expect(row.citation).toBe('LPA s.30')
  })

  it('lowering below the floor (5) is rejected with LVE-030 and the citation LPA s.30', async () => {
    const { db, config, service } = setup()
    config.seed({
      ruleKey: 'leave.annual.min_days',
      value: 6,
      statutoryFloor: 6,
      citation: 'LPA s.30',
      effectiveFrom: '1998-08-19',
      effectiveTo: null,
    })
    const created = await withTx(db, (tx) =>
      service.create(tx, {
        code: 'annual',
        nameI18n: { en: 'Annual Leave' },
        payMode: 'full',
        accrualMode: 'annual_grant',
        statutoryRuleKey: 'leave.annual.min_days',
        entitlementDays: '6',
      }),
    )

    await expect(withTx(db, (tx) => service.update(tx, created.id, { entitlementDays: '5' }))).rejects.toMatchObject({
      code: 'LVE-030',
      details: [expect.objectContaining({ citation: 'LPA s.30', statutoryFloor: 6, value: '5' })],
    })
  })

  it('raising above the floor (8) is accepted', async () => {
    const { db, config, service } = setup()
    config.seed({
      ruleKey: 'leave.annual.min_days',
      value: 6,
      statutoryFloor: 6,
      citation: 'LPA s.30',
      effectiveFrom: '1998-08-19',
      effectiveTo: null,
    })
    const created = await withTx(db, (tx) =>
      service.create(tx, {
        code: 'annual',
        nameI18n: { en: 'Annual Leave' },
        payMode: 'full',
        accrualMode: 'annual_grant',
        statutoryRuleKey: 'leave.annual.min_days',
        entitlementDays: '6',
      }),
    )

    const updated = await withTx(db, (tx) => service.update(tx, created.id, { entitlementDays: '8' }))
    expect(updated.entitlementDays).toBe('8')
  })

  it('the rejection is a real GadongError instance carrying httpStatus 422', async () => {
    const { db, config, service } = setup()
    config.seed({
      ruleKey: 'leave.annual.min_days',
      value: 6,
      statutoryFloor: 6,
      citation: 'LPA s.30',
      effectiveFrom: '1998-08-19',
      effectiveTo: null,
    })
    const created = await withTx(db, (tx) =>
      service.create(tx, { code: 'annual', nameI18n: { en: 'Annual' }, payMode: 'full', accrualMode: 'annual_grant', statutoryRuleKey: 'leave.annual.min_days', entitlementDays: '6' }),
    )
    let caught: unknown
    try {
      await withTx(db, (tx) => service.update(tx, created.id, { entitlementDays: '0' }))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(GadongError)
    expect((caught as GadongError).httpStatus).toBe(422)
  })
})

describe('LeaveTypesService — statutory floor: sick leave (LPA s.32) and maternity (LPA No. 9)', () => {
  it('sick leave below 30 is rejected citing LPA s.32', async () => {
    const { db, config, service } = setup()
    config.seed({ ruleKey: 'leave.sick.paid_days', value: 30, statutoryFloor: 30, citation: 'LPA s.32', effectiveFrom: '1998-08-19', effectiveTo: null })
    const created = await withTx(db, (tx) =>
      service.create(tx, { code: 'sick', nameI18n: { en: 'Sick' }, payMode: 'full', accrualMode: 'annual_grant', statutoryRuleKey: 'leave.sick.paid_days', entitlementDays: '30' }),
    )
    await expect(withTx(db, (tx) => service.update(tx, created.id, { entitlementDays: '29' }))).rejects.toMatchObject({
      code: 'LVE-030',
      details: [expect.objectContaining({ citation: 'LPA s.32' })],
    })
  })

  it('maternity below 120 is rejected citing LPA No. 9', async () => {
    const { db, config, service } = setup()
    config.seed({
      ruleKey: 'leave.maternity.days',
      value: 120,
      statutoryFloor: 120,
      citation: 'LPA No. 9 B.E. 2568',
      effectiveFrom: '2025-12-07',
      effectiveTo: null,
    })
    const created = await withTx(db, (tx) =>
      service.create(tx, { code: 'maternity', nameI18n: { en: 'Maternity' }, payMode: 'per_rule', accrualMode: 'annual_grant', statutoryRuleKey: 'leave.maternity.days', entitlementDays: '120' }),
    )
    await expect(withTx(db, (tx) => service.update(tx, created.id, { entitlementDays: '98' }))).rejects.toMatchObject({
      code: 'LVE-030',
      details: [expect.objectContaining({ citation: 'LPA No. 9 B.E. 2568', statutoryFloor: 120 })],
    })
  })

  it('creation itself is rejected when the initial entitlementDays is already below the floor', async () => {
    const { db, config, service } = setup()
    config.seed({ ruleKey: 'leave.sick.paid_days', value: 30, statutoryFloor: 30, citation: 'LPA s.32', effectiveFrom: '1998-08-19', effectiveTo: null })
    await expect(
      withTx(db, (tx) =>
        service.create(tx, { code: 'sick', nameI18n: { en: 'Sick' }, payMode: 'full', accrualMode: 'annual_grant', statutoryRuleKey: 'leave.sick.paid_days', entitlementDays: '10' }),
      ),
    ).rejects.toMatchObject({ code: 'LVE-030' })
  })
})

describe('LeaveTypesService — every figure is config-driven, not a constant', () => {
  it('the SAME entitlementDays that was rejected against a floor of 6 is accepted once the config floor is amended down to 4', async () => {
    const { db, config, service } = setup()
    config.seed({ ruleKey: 'leave.annual.min_days', value: 6, statutoryFloor: 6, citation: 'LPA s.30', effectiveFrom: '1998-08-19', effectiveTo: null })
    const created = await withTx(db, (tx) =>
      service.create(tx, { code: 'annual', nameI18n: { en: 'Annual' }, payMode: 'full', accrualMode: 'annual_grant', statutoryRuleKey: 'leave.annual.min_days', entitlementDays: '6' }),
    )

    await expect(withTx(db, (tx) => service.update(tx, created.id, { entitlementDays: '5' }))).rejects.toMatchObject({ code: 'LVE-030' })

    // The law changes (hypothetically) — config, not code, moves.
    config.amend('leave.annual.min_days', { statutoryFloor: 4, value: 4 })

    const updated = await withTx(db, (tx) => service.update(tx, created.id, { entitlementDays: '5' }))
    expect(updated.entitlementDays).toBe('5')
  })

  it('the SAME entitlementDays that was accepted against a floor of 6 is rejected once the config floor is amended UP to 10', async () => {
    const { db, config, service } = setup()
    config.seed({ ruleKey: 'leave.annual.min_days', value: 6, statutoryFloor: 6, citation: 'LPA s.30', effectiveFrom: '1998-08-19', effectiveTo: null })
    const created = await withTx(db, (tx) =>
      service.create(tx, { code: 'annual', nameI18n: { en: 'Annual' }, payMode: 'full', accrualMode: 'annual_grant', statutoryRuleKey: 'leave.annual.min_days', entitlementDays: '8' }),
    )
    expect(created.entitlementDays).toBe('8')

    config.amend('leave.annual.min_days', { statutoryFloor: 10, value: 10, citation: 'LPA s.30 (amended)' })

    await expect(withTx(db, (tx) => service.update(tx, created.id, { entitlementDays: '9' }))).rejects.toMatchObject({
      code: 'LVE-030',
      details: [expect.objectContaining({ citation: 'LPA s.30 (amended)', statutoryFloor: 10 })],
    })
  })

  it('the citation stored on the row is whatever config returns, never a literal duplicated in this codebase', async () => {
    const { db, config, service } = setup()
    config.seed({ ruleKey: 'leave.annual.min_days', value: 6, statutoryFloor: 6, citation: 'A completely arbitrary citation string for this test', effectiveFrom: '1998-08-19', effectiveTo: null })
    const created = await withTx(db, (tx) =>
      service.create(tx, { code: 'annual', nameI18n: { en: 'Annual' }, payMode: 'full', accrualMode: 'annual_grant', statutoryRuleKey: 'leave.annual.min_days', entitlementDays: '6' }),
    )
    expect(created.citation).toBe('A completely arbitrary citation string for this test')
  })
})

describe('LeaveTypesService — company-defined types (no statutory floor)', () => {
  it('a type with no statutoryRuleKey can be created and updated to any value freely', async () => {
    const { db, service } = setup()
    const created = await withTx(db, (tx) =>
      service.create(tx, { code: 'study_leave', nameI18n: { en: 'Study Leave' }, payMode: 'unpaid', accrualMode: 'annual_grant', entitlementDays: '15' }),
    )
    expect(created.statutoryRuleKey).toBeNull()
    expect(created.citation).toBeNull()

    const updated = await withTx(db, (tx) => service.update(tx, created.id, { entitlementDays: '2' }))
    expect(updated.entitlementDays).toBe('2')
  })
})

describe('LeaveTypesService — medical-certificate trigger floor (sick leave, LPA s.32 notes)', () => {
  it('a cert_trigger_days of 2 is rejected — the floor is "may not demand for fewer than 3"', async () => {
    const { db, config, service } = setup()
    config.seed({ ruleKey: 'leave.sick.cert_trigger_days', value: 3, statutoryFloor: 3, citation: 'LPA s.32', effectiveFrom: '1998-08-19', effectiveTo: null })
    await expect(
      withTx(db, (tx) =>
        service.create(tx, {
          code: 'sick',
          nameI18n: { en: 'Sick' },
          payMode: 'full',
          accrualMode: 'annual_grant',
          certTriggerRuleKey: 'leave.sick.cert_trigger_days',
          certTriggerDays: '2',
        }),
      ),
    ).rejects.toMatchObject({ code: 'LVE-030', details: [expect.objectContaining({ citation: 'LPA s.32', statutoryFloor: 3 })] })
  })

  it('a cert_trigger_days of exactly 3 (the floor) is accepted', async () => {
    const { db, config, service } = setup()
    config.seed({ ruleKey: 'leave.sick.cert_trigger_days', value: 3, statutoryFloor: 3, citation: 'LPA s.32', effectiveFrom: '1998-08-19', effectiveTo: null })
    const created = await withTx(db, (tx) =>
      service.create(tx, {
        code: 'sick',
        nameI18n: { en: 'Sick' },
        payMode: 'full',
        accrualMode: 'annual_grant',
        certTriggerRuleKey: 'leave.sick.cert_trigger_days',
        certTriggerDays: '3',
      }),
    )
    expect(created.certTriggerDays).toBe('3')
  })
})
