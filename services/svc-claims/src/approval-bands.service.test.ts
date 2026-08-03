import { ApprovalBandsRepository } from './approval-bands.repository'
import { ApprovalBandsService } from './approval-bands.service'
import { FakeClaimsDb } from './testing/fake-db'

function makeService(): { service: ApprovalBandsService; db: FakeClaimsDb } {
  const db = new FakeClaimsDb()
  const service = new ApprovalBandsService(new ApprovalBandsRepository(db.asPool()))
  return { service, db }
}

/**
 * Task 14 brief, THE test: "1,999 THB claim needs one approver; 2,001 needs
 * two. Change the band in config and assert the behaviour moves with it —
 * that proves it is configuration rather than a constant." Every threshold
 * in this suite comes from `replace()` (a config write to
 * `claims.approval_band`) — there is no `2000` literal anywhere in
 * `approval-bands.service.ts`.
 */
describe('ApprovalBandsService — M6-3 amount-banded approval chain, from CONFIG never from code', () => {
  it('with the PRD default bands (<=2000 manager only; >2000 manager+finance): 1999 needs one approver, 2001 needs two', async () => {
    const { service, db } = makeService()
    db.seedDefaultApprovalBands()

    await expect(service.bandsFor('1999.00')).resolves.toEqual(['manager'])
    await expect(service.bandsFor('2000.00')).resolves.toEqual(['manager']) // boundary is inclusive
    await expect(service.bandsFor('2001.00')).resolves.toEqual(['manager', 'finance'])
  })

  it('THE demonstration: moving the threshold in config to 5000 changes the SAME 2001 THB claim from two approvers to one, with no code change', async () => {
    const { service, db } = makeService()
    db.seedDefaultApprovalBands()

    // Before the config change: 2001 needs manager + finance.
    await expect(service.bandsFor('2001.00')).resolves.toEqual(['manager', 'finance'])

    const conn = db.connect()
    await conn.query('BEGIN')
    await service.replace(conn, [
      { maxAmount: '5000', approverRoles: ['manager'], sortOrder: 1 },
      { maxAmount: null, approverRoles: ['manager', 'finance'], sortOrder: 2 },
    ])
    await conn.query('COMMIT')

    // After the config change, the exact same amount now needs only one.
    await expect(service.bandsFor('2001.00')).resolves.toEqual(['manager'])
    // And a claim above the NEW threshold still needs both.
    await expect(service.bandsFor('5001.00')).resolves.toEqual(['manager', 'finance'])
  })

  it('supports a config with three or more bands (not hard-coded to exactly two)', async () => {
    const { service, db } = makeService()
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.replace(conn, [
      { maxAmount: '1000', approverRoles: ['manager'], sortOrder: 1 },
      { maxAmount: '10000', approverRoles: ['manager', 'finance'], sortOrder: 2 },
      { maxAmount: null, approverRoles: ['manager', 'finance', 'director'], sortOrder: 3 },
    ])
    await conn.query('COMMIT')

    await expect(service.bandsFor('999')).resolves.toEqual(['manager'])
    await expect(service.bandsFor('9999')).resolves.toEqual(['manager', 'finance'])
    await expect(service.bandsFor('50000')).resolves.toEqual(['manager', 'finance', 'director'])
  })

  it('bandsFor() throws a config error rather than defaulting when no bands are configured', async () => {
    const { service } = makeService()
    await expect(service.bandsFor('100')).rejects.toMatchObject({ code: 'CLM-016' })
  })

  describe('replace() validation — bad config is rejected before it can silently mis-route a claim', () => {
    it('rejects an empty band list', async () => {
      const { service, db } = makeService()
      const conn = db.connect()
      await conn.query('BEGIN')
      await expect(service.replace(conn, [])).rejects.toMatchObject({ code: 'CLM-016' })
    })

    it('rejects a top band with a non-null maxAmount (every config must have an unbounded top band)', async () => {
      const { service, db } = makeService()
      const conn = db.connect()
      await conn.query('BEGIN')
      await expect(
        service.replace(conn, [{ maxAmount: '2000', approverRoles: ['manager'], sortOrder: 1 }]),
      ).rejects.toMatchObject({ code: 'CLM-016' })
    })

    it('rejects a band with no approver roles', async () => {
      const { service, db } = makeService()
      const conn = db.connect()
      await conn.query('BEGIN')
      await expect(service.replace(conn, [{ maxAmount: null, approverRoles: [], sortOrder: 1 }])).rejects.toMatchObject({
        code: 'CLM-016',
      })
    })

    it('rejects non-contiguous sortOrder', async () => {
      const { service, db } = makeService()
      const conn = db.connect()
      await conn.query('BEGIN')
      await expect(
        service.replace(conn, [
          { maxAmount: '2000', approverRoles: ['manager'], sortOrder: 1 },
          { maxAmount: null, approverRoles: ['manager', 'finance'], sortOrder: 3 },
        ]),
      ).rejects.toMatchObject({ code: 'CLM-016' })
    })

    it('rejects non-increasing maxAmount across bands', async () => {
      const { service, db } = makeService()
      const conn = db.connect()
      await conn.query('BEGIN')
      await expect(
        service.replace(conn, [
          { maxAmount: '2000', approverRoles: ['manager'], sortOrder: 1 },
          { maxAmount: '1000', approverRoles: ['manager', 'finance'], sortOrder: 2 },
        ]),
      ).rejects.toMatchObject({ code: 'CLM-016' })
    })
  })

  it('list() returns bands ordered by sortOrder', async () => {
    const { service, db } = makeService()
    db.seedDefaultApprovalBands()
    const bands = await service.list()
    expect(bands.map((b) => b.sortOrder)).toEqual([1, 2])
    expect(bands[0]).toMatchObject({ maxAmount: '2000', approverRoles: ['manager'] })
    expect(bands[1]).toMatchObject({ maxAmount: null, approverRoles: ['manager', 'finance'] })
  })
})
