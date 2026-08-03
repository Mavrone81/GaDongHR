import { ConfigClient } from './config-client'
import type { ConfigTransport } from './config-client'
import { GuardrailPolicy } from './guardrail'
import { LeaveRefRepository } from './leave-ref.repository'
import { RosterRepository } from './roster.repository'
import { RosterService } from './roster.service'
import { ShiftsRepository } from './shifts.repository'
import type { NewShiftRow } from './shifts.repository'
import { FakeSchedulerDb } from './testing/fake-db'

function configTransport(dailyHours = 8, weeklyStandard = 48, weeklyHazardous = 42, weeklyOt = 36): ConfigTransport {
  const rules: Record<string, unknown> = {
    'hours.regular.max_per_day': { ruleKey: 'hours.regular.max_per_day', value: dailyHours, unit: 'hours', citation: 'LPA s.23', statutoryFloor: null, statutoryCeiling: dailyHours },
    'hours.regular.max_per_week': {
      ruleKey: 'hours.regular.max_per_week',
      value: { standard: weeklyStandard, hazardous: weeklyHazardous },
      unit: 'hours',
      citation: 'LPA s.23',
      statutoryFloor: null,
      statutoryCeiling: null,
    },
    'hours.ot.max_per_week': { ruleKey: 'hours.ot.max_per_week', value: weeklyOt, unit: 'hours', citation: 'LPA s.26', statutoryFloor: null, statutoryCeiling: weeklyOt },
  }
  return {
    get: (path: string) => {
      const key = /^\/rules\/([^?]+)/.exec(path)?.[1]
      const rule = key ? rules[decodeURIComponent(key)] : undefined
      return rule ? Promise.resolve(rule) : Promise.reject(new Error(`no such rule: ${String(key)}`))
    },
  }
}

const DAY_SHIFT: NewShiftRow = {
  nameI18n: { en: 'Day Shift' },
  startT: '08:00',
  endT: '16:00', // 8h
  crossesMidnight: false,
  breakRules: [],
  graceMin: 0,
  differential: null,
}

interface Harness {
  db: FakeSchedulerDb
  service: RosterService
  shiftId: string
}

async function setup(configHours?: { daily?: number; weeklyStandard?: number; weeklyHazardous?: number; weeklyOt?: number }): Promise<Harness> {
  const db = new FakeSchedulerDb()
  const shiftsRepo = new ShiftsRepository(db.asPool())
  const rosterRepo = new RosterRepository(db.asPool())
  const leaveRefRepo = new LeaveRefRepository(db.asPool())
  const guardrails = new GuardrailPolicy(
    new ConfigClient(configTransport(configHours?.daily, configHours?.weeklyStandard, configHours?.weeklyHazardous, configHours?.weeklyOt)),
  )
  const service = new RosterService(rosterRepo, shiftsRepo, leaveRefRepo, guardrails)

  const tx = db.connect()
  await tx.query('BEGIN')
  const shift = await shiftsRepo.insert(tx, DAY_SHIFT)
  await tx.query('COMMIT')

  return { db, service, shiftId: shift.id }
}

describe('RosterService.assign — double booking', () => {
  it('blocks assigning the exact same shift twice on the same day (SCH-011)', async () => {
    const { db, service, shiftId } = await setup()
    const tx = db.connect()
    await tx.query('BEGIN')
    await service.assign(tx, { employeeId: 'emp-1', shiftId, workDate: '2026-08-05' })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(service.assign(tx2, { employeeId: 'emp-1', shiftId, workDate: '2026-08-05' })).rejects.toMatchObject({
      code: 'SCH-011',
    })
  })
})

describe('RosterService.assign — leave collision (PRD M2-2 AC)', () => {
  it('WITHOUT a reason: rejects rostering onto a date with approved leave (SCH-012)', async () => {
    const { db, service, shiftId } = await setup()
    const leaveRepo = new LeaveRefRepository(db.asPool())
    const tx0 = db.connect()
    await tx0.query('BEGIN')
    await leaveRepo.upsertApproved(tx0, { employeeId: 'emp-1', leaveRequestId: 'req-1', dateFrom: '2026-08-05', dateTo: '2026-08-05' })
    await tx0.query('COMMIT')

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(service.assign(tx, { employeeId: 'emp-1', shiftId, workDate: '2026-08-05' })).rejects.toMatchObject({
      code: 'SCH-012',
    })
  })

  it('WITH a reason: warns but creates the entry, recording the override reason on the record', async () => {
    const { db, service, shiftId } = await setup()
    const leaveRepo = new LeaveRefRepository(db.asPool())
    const tx0 = db.connect()
    await tx0.query('BEGIN')
    await leaveRepo.upsertApproved(tx0, { employeeId: 'emp-1', leaveRequestId: 'req-1', dateFrom: '2026-08-05', dateTo: '2026-08-05' })
    await tx0.query('COMMIT')

    const tx = db.connect()
    await tx.query('BEGIN')
    const result = await service.assign(tx, {
      employeeId: 'emp-1',
      shiftId,
      workDate: '2026-08-05',
      overrideReason: 'covering for a same-shift colleague, HR notified',
    })
    await tx.query('COMMIT')

    expect(result.entry.overrideReason).toBe('covering for a same-shift colleague, HR notified')
    expect(result.conflictReport.items.some((c) => c.code === 'SCH-012')).toBe(true)
  })
})

describe('RosterService.assign — statutory hours guardrails (M2-4)', () => {
  it('blocks a day that would exceed the 8h daily ceiling', async () => {
    const { db, service, shiftId } = await setup({ daily: 8 })
    const shiftsRepo = new ShiftsRepository(db.asPool())
    const tx0 = db.connect()
    await tx0.query('BEGIN')
    const longShift = await shiftsRepo.insert(tx0, { ...DAY_SHIFT, startT: '08:00', endT: '17:00' }) // 9h
    await tx0.query('COMMIT')
    void shiftId

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(service.assign(tx, { employeeId: 'emp-1', shiftId: longShift.id, workDate: '2026-08-05' })).rejects.toMatchObject({
      code: 'SCH-010',
    })
  })

  it('47.5 projected weekly hours warns (still creates the entry) — running total surfaced', async () => {
    const { db, service } = await setup({ weeklyStandard: 48 })
    const shiftsRepo = new ShiftsRepository(db.asPool())
    // 5 x 7.9h = 39.5h existing, plus a final 8h shift = 47.5h.
    const tx0 = db.connect()
    await tx0.query('BEGIN')
    const shortShift = await shiftsRepo.insert(tx0, { ...DAY_SHIFT, startT: '08:00', endT: '15:54' }) // 7.9h
    const fullShift = await shiftsRepo.insert(tx0, DAY_SHIFT) // 8h
    await tx0.query('COMMIT')

    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    for (const day of days) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await service.assign(tx, { employeeId: 'emp-1', shiftId: shortShift.id, workDate: day })
      await tx.query('COMMIT')
    }

    const tx = db.connect()
    await tx.query('BEGIN')
    const result = await service.assign(tx, { employeeId: 'emp-1', shiftId: fullShift.id, workDate: '2026-08-08' }) // Saturday, same ISO week
    await tx.query('COMMIT')

    expect(result.totals.weekly.hours).toBe('47.50')
    expect(result.totals.weekly.ceilingHours).toBe('48.00')
    expect(result.conflictReport.items.find((c) => c.code === 'SCH-010')?.severity).toBe('warn')
  })

  it('48.5 projected weekly hours blocks when the daily ceiling is not itself the binding constraint', async () => {
    const { db, service } = await setup({ daily: 24, weeklyStandard: 48 })
    const shiftsRepo = new ShiftsRepository(db.asPool())
    const tx0 = db.connect()
    await tx0.query('BEGIN')
    const shortShift = await shiftsRepo.insert(tx0, { ...DAY_SHIFT, startT: '08:00', endT: '15:54' }) // 7.9h
    const finalShift = await shiftsRepo.insert(tx0, { ...DAY_SHIFT, startT: '08:00', endT: '17:00' }) // 9h
    await tx0.query('COMMIT')

    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    for (const day of days) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await service.assign(tx, { employeeId: 'emp-1', shiftId: shortShift.id, workDate: day })
      await tx.query('COMMIT')
    }
    // existing = 5 * 7.9 = 39.5h; + 9h = 48.5h > 48h ceiling.
    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(service.assign(tx, { employeeId: 'emp-1', shiftId: finalShift.id, workDate: '2026-08-08' })).rejects.toMatchObject({
      code: 'SCH-010',
    })
  })

  it('CONFIG-DRIVEN: the hazardous flag selects the 42h ceiling instead of 48h, sourced entirely from config', async () => {
    const { db, service } = await setup({ daily: 24, weeklyStandard: 48, weeklyHazardous: 42 })
    const shiftsRepo = new ShiftsRepository(db.asPool())
    const tx0 = db.connect()
    await tx0.query('BEGIN')
    const shift10h = await shiftsRepo.insert(tx0, { ...DAY_SHIFT, startT: '08:00', endT: '18:00' }) // 10h
    await tx0.query('COMMIT')

    // 4 x 10h = 40h existing (hazardous), + 1 x 10h = 50h > 42h hazardous ceiling.
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']
    for (const day of days) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await service.assign(tx, { employeeId: 'emp-1', shiftId: shift10h.id, workDate: day, hazardous: true })
      await tx.query('COMMIT')
    }

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(
      service.assign(tx, { employeeId: 'emp-1', shiftId: shift10h.id, workDate: '2026-08-07', hazardous: true }),
    ).rejects.toMatchObject({ code: 'SCH-010' })
  })
})

describe('RosterService.overrideExisting', () => {
  it('records a reason on an already-existing entry, and rejects an empty reason', async () => {
    const { db, service, shiftId } = await setup()
    const tx = db.connect()
    await tx.query('BEGIN')
    const { entry } = await service.assign(tx, { employeeId: 'emp-1', shiftId, workDate: '2026-08-05' })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(service.overrideExisting(tx2, entry.id, '')).rejects.toMatchObject({ code: 'SCH-012' })
    const updated = await service.overrideExisting(tx2, entry.id, 'leave approved after roster was planned')
    await tx2.query('COMMIT')
    expect(updated.overrideReason).toBe('leave approved after roster was planned')
  })
})

describe('RosterService.publish', () => {
  it('publishes planned entries in range and emits roster.published in the same transaction', async () => {
    const { db, service, shiftId } = await setup()
    const tx = db.connect()
    await tx.query('BEGIN')
    await service.assign(tx, { employeeId: 'emp-1', shiftId, workDate: '2026-08-05' })
    await service.assign(tx, { employeeId: 'emp-2', shiftId, workDate: '2026-08-06' })
    const result = await service.publish(tx, { from: '2026-08-01', to: '2026-08-31', orgUnitId: 'org-1' })
    await tx.query('COMMIT')

    expect(result.entryCount).toBe(2)
    const outboxRows = db.debugOutboxRows()
    expect(outboxRows).toHaveLength(1)
    expect(outboxRows[0]?.topic).toBe('roster.published')
    expect(outboxRows[0]?.payload).toMatchObject({
      orgUnitId: 'org-1',
      dateRange: { from: '2026-08-01', to: '2026-08-31' },
      entryCount: 2,
    })
  })
})

describe('RosterService.copyPattern', () => {
  it('copies entries to the offset target range, skipping ones that would double-book', async () => {
    const { db, service, shiftId } = await setup()
    const tx0 = db.connect()
    await tx0.query('BEGIN')
    await service.assign(tx0, { employeeId: 'emp-1', shiftId, workDate: '2026-08-03' }) // Monday
    await service.assign(tx0, { employeeId: 'emp-1', shiftId, workDate: '2026-08-04' }) // Tuesday
    await tx0.query('COMMIT')

    const tx = db.connect()
    await tx.query('BEGIN')
    const result = await service.copyPattern(tx, { sourceFrom: '2026-08-03', sourceTo: '2026-08-04', targetFrom: '2026-08-10' })
    await tx.query('COMMIT')

    expect(result.created).toHaveLength(2)
    expect(result.created.map((e) => e.workDate).sort()).toEqual(['2026-08-10', '2026-08-11'])
  })
})
