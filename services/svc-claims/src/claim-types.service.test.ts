import { ClaimTypesRepository } from './claim-types.repository'
import { ClaimTypesService } from './claim-types.service'
import { FakeClaimsDb } from './testing/fake-db'

function makeService(): { service: ClaimTypesService; db: FakeClaimsDb } {
  const db = new FakeClaimsDb()
  const service = new ClaimTypesService(new ClaimTypesRepository(db.asPool()))
  return { service, db }
}

describe('ClaimTypesService — M6-1 configurable claim types', () => {
  it('creates a type with per-claim/monthly/annual limits, required fields, and receipt requirement', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    const created = await service.create(conn, {
      code: 'travel',
      name: 'Travel',
      perClaimLimit: '5000',
      perClaimLimitKind: 'hard',
      monthlyLimit: '15000',
      monthlyLimitKind: 'soft',
      receiptRequired: true,
      requiredFields: ['destination'],
    })
    await conn.query('COMMIT')

    expect(created).toMatchObject({
      code: 'travel',
      perClaimLimit: '5000',
      perClaimLimitKind: 'hard',
      monthlyLimit: '15000',
      monthlyLimitKind: 'soft',
      receiptRequired: true,
      requiredFields: ['destination'],
      active: true,
    })

    const fetched = await service.get('travel')
    expect(fetched.code).toBe('travel')
  })

  it('rejects a limit without its kind, and a kind without its limit', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(
      service.create(conn, { code: 'meal', name: 'Meal', perClaimLimit: '500', receiptRequired: false }),
    ).rejects.toMatchObject({ code: 'CLM-016' })
    await expect(
      service.create(conn, { code: 'meal', name: 'Meal', perClaimLimitKind: 'hard', receiptRequired: false }),
    ).rejects.toMatchObject({ code: 'CLM-016' })
  })

  it('an active mileage type requires mileageRate', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(
      service.create(conn, { code: 'mileage', name: 'Mileage', receiptRequired: false, active: true }),
    ).rejects.toMatchObject({ code: 'CLM-016' })

    const created = await service.create(conn, {
      code: 'mileage',
      name: 'Mileage',
      receiptRequired: false,
      mileageRate: '4.25',
      active: true,
    })
    expect(created.mileageRate).toBe('4.25')
  })

  it('get() throws CLM-404 for an unknown code', async () => {
    const { service } = makeService()
    await expect(service.get('does-not-exist')).rejects.toMatchObject({ code: 'CLM-404' })
  })

  it('update() replaces the mutable fields of an existing type', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.create(conn, { code: 'meal', name: 'Meal', receiptRequired: false, perClaimLimit: '300', perClaimLimitKind: 'soft' })
    const updated = await service.update(conn, 'meal', {
      name: 'Meal Allowance',
      receiptRequired: true,
      perClaimLimit: '400',
      perClaimLimitKind: 'hard',
    })
    await conn.query('COMMIT')

    expect(updated).toMatchObject({ code: 'meal', name: 'Meal Allowance', receiptRequired: true, perClaimLimit: '400', perClaimLimitKind: 'hard' })
  })

  it('update() throws CLM-404 for an unknown code', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(service.update(conn, 'nope', { name: 'x', receiptRequired: false })).rejects.toMatchObject({ code: 'CLM-404' })
  })

  it('list() returns every type ordered by code', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.create(conn, { code: 'travel', name: 'Travel', receiptRequired: true })
    await service.create(conn, { code: 'meal', name: 'Meal', receiptRequired: false })
    await conn.query('COMMIT')

    const list = await service.list()
    expect(list.map((t) => t.code)).toEqual(['meal', 'travel'])
  })
})
