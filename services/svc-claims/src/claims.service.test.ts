import { CryptoClient } from '@gadong/kernel'
import { ClaimTypesRepository } from './claim-types.repository'
import { ApprovalBandsRepository } from './approval-bands.repository'
import { ApprovalBandsService } from './approval-bands.service'
import { ClaimsRepository } from './claims.repository'
import { ClaimsService } from './claims.service'
import type { SubmitClaimInput } from './claims.service'
import { FakeClaimsDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'

function makeService(): {
  service: ClaimsService
  db: FakeClaimsDb
  claimTypes: ClaimTypesRepository
} {
  const db = new FakeClaimsDb()
  db.seedDefaultApprovalBands()
  const claimTypes = new ClaimTypesRepository(db.asPool())
  const bands = new ApprovalBandsService(new ApprovalBandsRepository(db.asPool()))
  const service = new ClaimsService(new ClaimsRepository(db.asPool()), claimTypes, bands, new CryptoClient(fakeCryptoTransport()))
  return { service, db, claimTypes }
}

async function seedType(
  db: FakeClaimsDb,
  claimTypes: ClaimTypesRepository,
  overrides: Partial<Parameters<ClaimTypesRepository['insert']>[1]> = {},
): Promise<void> {
  const conn = db.connect()
  await conn.query('BEGIN')
  await claimTypes.insert(conn, {
    code: 'travel',
    name: 'Travel',
    perClaimLimit: null,
    perClaimLimitKind: null,
    monthlyLimit: null,
    monthlyLimitKind: null,
    annualLimit: null,
    annualLimitKind: null,
    receiptRequired: true,
    requiredFields: [],
    mileageRate: null,
    active: true,
    ...overrides,
  })
  await conn.query('COMMIT')
}

function baseInput(overrides: Partial<SubmitClaimInput> = {}): SubmitClaimInput {
  return {
    employeeId: 'emp-1',
    claimTypeCode: 'travel',
    claimDate: '2026-08-01',
    vendor: 'BTS Skytrain',
    amountThb: '500.00',
    receipts: [{ fileRef: 'storage-key://receipts/emp-1/r1.jpg', vatAmount: '32.71' }],
    ...overrides,
  }
}

describe('ClaimsService.submit — M6-2 submission', () => {
  it('creates a pending claim and one approval step per band level', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.submit(conn, baseInput())
    await conn.query('COMMIT')

    expect(result.claim.status).toBe('pending')
    expect(result.claim.amountThb).toBe('500.00')
    expect(result.claim.round).toBe(1)
    expect(db.debugSteps()).toHaveLength(1) // 500 THB is within the manager-only band
    expect(db.debugSteps()[0]).toMatchObject({ approver_role: 'manager', level: 1, round: 1, decision: null })
  })

  it('VAT: claim.vatAmount is the sum of every receipt.vatAmount', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.submit(
      conn,
      baseInput({ receipts: [{ fileRef: 'k1', vatAmount: '10.50' }, { fileRef: 'k2', vatAmount: '5.25' }] }),
    )
    await conn.query('COMMIT')

    expect(result.claim.vatAmount).toBe('15.75')
  })

  it('mileage claims compute amount from distance x the type-configured rate — never a hard-coded rate', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { code: 'mileage', name: 'Mileage', receiptRequired: false, mileageRate: '4.25' })

    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.submit(
      conn,
      baseInput({ claimTypeCode: 'mileage', mileageKm: '12.5', amountThb: undefined, receipts: [] }),
    )
    await conn.query('COMMIT')

    // 12.5 km x 4.25 THB/km = 53.125, rounded half-up to 2dp = 53.13
    expect(result.claim.amountThb).toBe('53.13')
    expect(result.claim.mileageKm).toBe('12.5')
  })

  it('mileage claim throws CLM-013 when the type has no configured rate', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { code: 'mileage', name: 'Mileage', receiptRequired: false, mileageRate: null, active: false })
    // Re-activate WITHOUT a rate directly through the repo (bypassing ClaimTypesService's own guard) to exercise ClaimsService's independent check.
    const conn0 = db.connect()
    await conn0.query('BEGIN')
    await claimTypes.update(conn0, 'mileage', {
      name: 'Mileage',
      perClaimLimit: null,
      perClaimLimitKind: null,
      monthlyLimit: null,
      monthlyLimitKind: null,
      annualLimit: null,
      annualLimitKind: null,
      receiptRequired: false,
      requiredFields: [],
      mileageRate: null,
      active: true,
    })
    await conn0.query('COMMIT')

    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(
      service.submit(conn, baseInput({ claimTypeCode: 'mileage', mileageKm: '10', amountThb: undefined, receipts: [] })),
    ).rejects.toMatchObject({ code: 'CLM-013' })
  })

  it('throws CLM-012 when the type requires a receipt and none is provided', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { receiptRequired: true })

    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(service.submit(conn, baseInput({ receipts: [] }))).rejects.toMatchObject({ code: 'CLM-012' })
  })

  it('throws CLM-014 when a required field is missing', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { requiredFields: ['destination'] })

    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(service.submit(conn, baseInput({ fields: {} }))).rejects.toMatchObject({ code: 'CLM-014' })
  })

  it('succeeds once the required field is present', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { requiredFields: ['destination'] })

    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.submit(conn, baseInput({ fields: { destination: 'Chiang Mai' } }))
    expect(result.claim.fields).toEqual({ destination: 'Chiang Mai' })
  })

  it('amounts are numeric strings throughout — the stored amount_thb is never a JS number', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.submit(conn, baseInput({ amountThb: '1999.99' }))
    await conn.query('COMMIT')

    expect(typeof result.claim.amountThb).toBe('string')
    expect(result.claim.amountThb).toBe('1999.99')
  })
})

describe('ClaimsService.submit — receipt encryption (Task 14 brief THE test)', () => {
  it('the stored receipt.file_ref is ciphertext — the raw column never contains the plaintext pointer', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const plaintextPointer = 'storage-key://receipts/emp-1/very-specific-receipt-name.jpg'
    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.submit(conn, baseInput({ receipts: [{ fileRef: plaintextPointer }] }))
    await conn.query('COMMIT')

    const stored = db.debugReceipts().find((r) => r.claim_id === result.claim.id)
    expect(stored).toBeDefined()
    expect(Buffer.isBuffer(stored!.file_ref)).toBe(true)
    expect(stored!.file_ref.length).toBeGreaterThanOrEqual(125)

    const asLatin1 = stored!.file_ref.toString('latin1')
    expect(asLatin1).not.toContain(plaintextPointer)
    expect(asLatin1).not.toContain('very-specific-receipt-name')
  })

  it('stores one encrypted receipt row per submitted receipt', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.submit(
      conn,
      baseInput({ receipts: [{ fileRef: 'k1' }, { fileRef: 'k2' }, { fileRef: 'k3' }] }),
    )
    await conn.query('COMMIT')

    expect(db.debugReceipts().filter((r) => r.claim_id === result.claim.id)).toHaveLength(3)
  })
})

describe('ClaimsService.submit — M6-5 duplicate-receipt detection via dup_hash (amount+date+vendor)', () => {
  it('a second submission with the same amount, date and vendor is blocked as a suspected duplicate', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    await service.submit(conn1, baseInput())
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(service.submit(conn2, baseInput())).rejects.toMatchObject({ code: 'CLM-011' })
  })

  it('vendor matching is case/whitespace insensitive (both normalised before hashing)', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    await service.submit(conn1, baseInput({ vendor: 'BTS Skytrain' }))
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(service.submit(conn2, baseInput({ vendor: '  bts skytrain  ' }))).rejects.toMatchObject({ code: 'CLM-011' })
  })

  it('a different amount, date, or vendor is NOT flagged as a duplicate', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    await service.submit(conn1, baseInput())
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(service.submit(conn2, baseInput({ amountThb: '501.00' }))).resolves.toBeDefined()

    const conn3 = db.connect()
    await conn3.query('BEGIN')
    await expect(service.submit(conn3, baseInput({ claimDate: '2026-08-02' }))).resolves.toBeDefined()

    const conn4 = db.connect()
    await conn4.query('BEGIN')
    await expect(service.submit(conn4, baseInput({ vendor: 'Grab' }))).resolves.toBeDefined()
  })

  it('a REJECTED claim does not block a resubmission that reuses the same amount/date/vendor', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const first = await service.submit(conn1, baseInput())
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await service.decide(conn2, first.claim.id, 'manager', 'mgr-1', 'rejected', 'missing receipt detail')
    await conn2.query('COMMIT')

    const conn3 = db.connect()
    await conn3.query('BEGIN')
    // A brand-new claim (not a resubmit of `first`) with the identical amount/date/vendor is allowed, because the only
    // existing match is `rejected`.
    await expect(service.submit(conn3, baseInput())).resolves.toBeDefined()
  })
})

describe('ClaimsService.submit — M6-5 hard vs soft limit enforcement', () => {
  it('a HARD per-claim limit blocks a claim over the ceiling', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { perClaimLimit: '1000', perClaimLimitKind: 'hard' })

    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(service.submit(conn, baseInput({ amountThb: '1000.01' }))).rejects.toMatchObject({ code: 'CLM-010' })
  })

  it('a claim exactly at a HARD limit is allowed (the limit is inclusive)', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { perClaimLimit: '1000', perClaimLimitKind: 'hard' })

    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(service.submit(conn, baseInput({ amountThb: '1000.00' }))).resolves.toBeDefined()
  })

  it('a SOFT per-claim limit does NOT block — the claim proceeds and is flagged', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { perClaimLimit: '1000', perClaimLimitKind: 'soft' })

    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.submit(conn, baseInput({ amountThb: '1500.00' }))
    await conn.query('COMMIT')

    expect(result.claim.status).toBe('pending')
    expect(result.claim.softLimitWarning).toBe(true)
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('per_claim')]))
  })

  it('demonstrates BOTH in the same suite: identical claim type, hard blocks at 1000.01, soft (same limit) proceeds with a warning', async () => {
    const { db, claimTypes } = makeService()

    // Hard variant.
    await seedType(db, claimTypes, { code: 'travel', perClaimLimit: '1000', perClaimLimitKind: 'hard' })
    const hardService = new ClaimsService(
      new ClaimsRepository(db.asPool()),
      claimTypes,
      new ApprovalBandsService(new ApprovalBandsRepository(db.asPool())),
      new CryptoClient(fakeCryptoTransport()),
    )
    const connHard = db.connect()
    await connHard.query('BEGIN')
    await expect(hardService.submit(connHard, baseInput({ amountThb: '1000.01' }))).rejects.toMatchObject({ code: 'CLM-010' })

    // Flip the SAME type to soft.
    const connFlip = db.connect()
    await connFlip.query('BEGIN')
    await claimTypes.update(connFlip, 'travel', {
      name: 'Travel',
      perClaimLimit: '1000',
      perClaimLimitKind: 'soft',
      monthlyLimit: null,
      monthlyLimitKind: null,
      annualLimit: null,
      annualLimitKind: null,
      receiptRequired: true,
      requiredFields: [],
      mileageRate: null,
      active: true,
    })
    await connFlip.query('COMMIT')

    const connSoft = db.connect()
    await connSoft.query('BEGIN')
    const softResult = await hardService.submit(connSoft, baseInput({ amountThb: '1000.01' }))
    expect(softResult.claim.softLimitWarning).toBe(true)
    expect(softResult.claim.status).toBe('pending')
  })

  it('a HARD monthly limit blocks once cumulative approved+pending claims for the month would exceed it', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { monthlyLimit: '800', monthlyLimitKind: 'hard' })

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    await service.submit(conn1, baseInput({ amountThb: '500.00', vendor: 'A' }))
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(service.submit(conn2, baseInput({ amountThb: '400.00', vendor: 'B' }))).rejects.toMatchObject({
      code: 'CLM-010',
    })
  })

  it('a HARD annual limit blocks across different months in the same year', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { annualLimit: '800', annualLimitKind: 'hard' })

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    await service.submit(conn1, baseInput({ amountThb: '500.00', vendor: 'A', claimDate: '2026-01-15' }))
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(
      service.submit(conn2, baseInput({ amountThb: '400.00', vendor: 'B', claimDate: '2026-11-01' })),
    ).rejects.toMatchObject({ code: 'CLM-010' })
  })

  it('a claim in a DIFFERENT year does not count against the annual limit', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes, { annualLimit: '800', annualLimitKind: 'hard' })

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    await service.submit(conn1, baseInput({ amountThb: '500.00', vendor: 'A', claimDate: '2025-12-31' }))
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(
      service.submit(conn2, baseInput({ amountThb: '400.00', vendor: 'B', claimDate: '2026-01-01' })),
    ).resolves.toBeDefined()
  })
})

describe('ClaimsService.decide — M6-3 banded approval chain', () => {
  it('a 1,999 THB claim needs only a manager decision to become approved', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput({ amountThb: '1999.00' }))
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    const decided = await service.decide(conn2, submitted.claim.id, 'manager', 'mgr-1', 'approved', null)
    await conn2.query('COMMIT')

    expect(decided.status).toBe('approved')
  })

  it('a 2,001 THB claim requires manager AND finance — manager alone leaves it pending', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput({ amountThb: '2001.00' }))
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    const afterManager = await service.decide(conn2, submitted.claim.id, 'manager', 'mgr-1', 'approved', null)
    await conn2.query('COMMIT')
    expect(afterManager.status).toBe('pending')

    const conn3 = db.connect()
    await conn3.query('BEGIN')
    const afterFinance = await service.decide(conn3, submitted.claim.id, 'finance', 'fin-1', 'approved', null)
    await conn3.query('COMMIT')
    expect(afterFinance.status).toBe('approved')
  })

  it('a finance decision on a manager-only (<=2000) claim is rejected as CLM-020 (approver outside band)', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput({ amountThb: '1999.00' }))
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(service.decide(conn2, submitted.claim.id, 'finance', 'fin-1', 'approved', null)).rejects.toMatchObject({
      code: 'CLM-020',
    })
  })

  it('a second manager decision after manager already approved a 2-level claim is also CLM-020 (the pending level moved to finance)', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput({ amountThb: '2001.00' }))
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await service.decide(conn2, submitted.claim.id, 'manager', 'mgr-1', 'approved', null)
    await conn2.query('COMMIT')

    const conn3 = db.connect()
    await conn3.query('BEGIN')
    await expect(service.decide(conn3, submitted.claim.id, 'manager', 'mgr-2', 'approved', null)).rejects.toMatchObject({
      code: 'CLM-020',
    })
  })

  it('THE config-driven proof: changing the band threshold changes how many decisions the SAME 2,001 THB claim needs', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)
    const bandsRepo = new ApprovalBandsRepository(db.asPool())
    const bandsService = new ApprovalBandsService(bandsRepo)

    // Raise the threshold to 5000 in config.
    const connCfg = db.connect()
    await connCfg.query('BEGIN')
    await bandsService.replace(connCfg, [
      { maxAmount: '5000', approverRoles: ['manager'], sortOrder: 1 },
      { maxAmount: null, approverRoles: ['manager', 'finance'], sortOrder: 2 },
    ])
    await connCfg.query('COMMIT')

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput({ amountThb: '2001.00' }))
    await conn1.query('COMMIT')

    // Now a single manager decision is enough — the SAME amount that needed two decisions before the config change.
    const conn2 = db.connect()
    await conn2.query('BEGIN')
    const decided = await service.decide(conn2, submitted.claim.id, 'manager', 'mgr-1', 'approved', null)
    await conn2.query('COMMIT')

    expect(decided.status).toBe('approved')
  })
})

describe('ClaimsService — rejection with reason, then resubmission, end to end', () => {
  it('rejection requires a non-empty reason', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput())
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(service.decide(conn2, submitted.claim.id, 'manager', 'mgr-1', 'rejected', '')).rejects.toMatchObject({
      code: 'CLM-015',
    })
    await expect(service.decide(conn2, submitted.claim.id, 'manager', 'mgr-1', 'rejected', null)).rejects.toMatchObject({
      code: 'CLM-015',
    })
  })

  it('a rejected claim can be resubmitted, gets a new round, and re-enters the approval chain', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput({ amountThb: '500.00' }))
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    const rejected = await service.decide(conn2, submitted.claim.id, 'manager', 'mgr-1', 'rejected', 'need itemised receipt')
    await conn2.query('COMMIT')
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectionReason).toBe('need itemised receipt')

    const conn3 = db.connect()
    await conn3.query('BEGIN')
    const resubmitted = await service.resubmit(conn3, submitted.claim.id, 'emp-1', {
      amountThb: '520.00',
      receipts: [{ fileRef: 'itemised-receipt-key' }],
    })
    await conn3.query('COMMIT')

    expect(resubmitted.claim.status).toBe('pending')
    expect(resubmitted.claim.round).toBe(2)
    expect(resubmitted.claim.amountThb).toBe('520.00')
    expect(resubmitted.claim.rejectionReason).toBeNull()

    // The new round has its own fresh approval step.
    const round2Steps = db.debugSteps().filter((s) => s.subject_id === submitted.claim.id && s.round === 2)
    expect(round2Steps).toHaveLength(1)
    expect(round2Steps[0]).toMatchObject({ decision: null, approver_role: 'manager' })

    // It can now be approved end to end.
    const conn4 = db.connect()
    await conn4.query('BEGIN')
    const approved = await service.decide(conn4, submitted.claim.id, 'manager', 'mgr-1', 'approved', null)
    await conn4.query('COMMIT')
    expect(approved.status).toBe('approved')
  })

  it('resubmit() throws CLM-409 (claim_not_rejected) for a claim that was never rejected', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput())
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(service.resubmit(conn2, submitted.claim.id, 'emp-1', {})).rejects.toMatchObject({ code: 'CLM-409' })
  })

  it('resubmit() throws CLM-403 (not_claim_owner) for a different employee', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput())
    await conn1.query('COMMIT')
    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await service.decide(conn2, submitted.claim.id, 'manager', 'mgr-1', 'rejected', 'no')
    await conn2.query('COMMIT')

    const conn3 = db.connect()
    await conn3.query('BEGIN')
    await expect(service.resubmit(conn3, submitted.claim.id, 'someone-else', {})).rejects.toMatchObject({ code: 'CLM-403' })
  })
})

describe('ClaimsService.route — M6-4 reimbursement routing', () => {
  async function approvedClaim(amountThb = '500.00') {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)
    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput({ amountThb }))
    await conn1.query('COMMIT')
    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await service.decide(conn2, submitted.claim.id, 'manager', 'mgr-1', 'approved', null)
    await conn2.query('COMMIT')
    return { service, db, claimId: submitted.claim.id }
  }

  it('routing to payroll marks the claim for_payroll and publishes claim.approved_for_payroll with the non-taxable flag', async () => {
    const { service, db, claimId } = await approvedClaim()

    const conn = db.connect()
    await conn.query('BEGIN')
    const routed = await service.route(conn, claimId, 'payroll')
    await conn.query('COMMIT')

    expect(routed.status).toBe('for_payroll')
    expect(routed.reimbursementRoute).toBe('payroll')

    const outboxRow = db.debugOutboxRows().find((r) => r.topic === 'claim.approved_for_payroll')
    expect(outboxRow).toBeDefined()
    expect(outboxRow!.payload).toMatchObject({
      claimId,
      employeeId: 'emp-1',
      amountThb: '500.00',
      claimType: 'travel',
      taxable: false,
      ssoWageBase: false,
    })
  })

  it('routing off-cycle marks the claim paid_offcycle and publishes claim.paid_offcycle', async () => {
    const { service, db, claimId } = await approvedClaim('750.00')

    const conn = db.connect()
    await conn.query('BEGIN')
    const routed = await service.route(conn, claimId, 'offcycle')
    await conn.query('COMMIT')

    expect(routed.status).toBe('paid_offcycle')
    expect(routed.reimbursementRoute).toBe('offcycle')
    expect(routed.paidAt).not.toBeNull()

    const outboxRow = db.debugOutboxRows().find((r) => r.topic === 'claim.paid_offcycle')
    expect(outboxRow).toBeDefined()
    expect(outboxRow!.payload).toMatchObject({ claimId, employeeId: 'emp-1', taxable: false })
  })

  it('the outbox row is written in the SAME transaction as the status change — rolling back loses both', async () => {
    const { service, db, claimId } = await approvedClaim()

    const conn = db.connect()
    await conn.query('BEGIN')
    await service.route(conn, claimId, 'payroll')
    await conn.query('ROLLBACK')

    const claim = db.debugClaims().find((c) => c.id === claimId)
    expect(claim!.status).toBe('approved') // unchanged
    expect(db.debugOutboxRows()).toHaveLength(0)
  })

  it('routing an already-routed claim again throws CLM-030 (route locked)', async () => {
    const { service, db, claimId } = await approvedClaim()

    const conn1 = db.connect()
    await conn1.query('BEGIN')
    await service.route(conn1, claimId, 'payroll')
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(service.route(conn2, claimId, 'offcycle')).rejects.toMatchObject({ code: 'CLM-030' })
  })

  it('routing a claim that was never approved throws CLM-409 (claim_not_approved)', async () => {
    const { service, db, claimTypes } = makeService()
    await seedType(db, claimTypes)
    const conn1 = db.connect()
    await conn1.query('BEGIN')
    const submitted = await service.submit(conn1, baseInput())
    await conn1.query('COMMIT')

    const conn2 = db.connect()
    await conn2.query('BEGIN')
    await expect(service.route(conn2, submitted.claim.id, 'payroll')).rejects.toMatchObject({ code: 'CLM-409' })
  })

  it('status is visible to the employee end-to-end via listForEmployee', async () => {
    const { service, db, claimId } = await approvedClaim()

    let claims = await service.listForEmployee('emp-1')
    expect(claims.find((c) => c.id === claimId)?.status).toBe('approved')

    const conn = db.connect()
    await conn.query('BEGIN')
    await service.route(conn, claimId, 'payroll')
    await conn.query('COMMIT')

    claims = await service.listForEmployee('emp-1')
    expect(claims.find((c) => c.id === claimId)?.status).toBe('for_payroll')
  })
})
