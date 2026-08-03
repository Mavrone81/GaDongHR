import { ConsentRepository } from './consent.repository'
import { ConstraintViolation, FakeOnboardingDb } from './testing/fake-db'

describe('ConsentRepository — against FakeOnboardingDb', () => {
  it('findForm() resolves a seeded form by purpose/lang/version', async () => {
    const db = new FakeOnboardingDb()
    db.seedConsentForm({ purpose: 'hr_processing', lang: 'th', version: 1, body_text: 'HR processing notice text' })
    db.seedConsentForm({ purpose: 'biometric', lang: 'th', version: 1, body_text: 'Biometric consent text' })
    const repo = new ConsentRepository(db.asPool())

    const hr = await repo.findForm('hr_processing', 'th', 1)
    expect(hr?.bodyText).toBe('HR processing notice text')

    const bio = await repo.findForm('biometric', 'th', 1)
    expect(bio?.bodyText).toBe('Biometric consent text')

    expect(await repo.findForm('biometric', 'th', 2)).toBeNull()
  })

  it('insertRecord() then findRecordsByEmployeeAndPurpose() returns most-recent-first', async () => {
    const db = new FakeOnboardingDb()
    const form = db.seedConsentForm({ purpose: 'biometric', lang: 'th', version: 1, body_text: 'text' })
    const conn = db.connect()
    const repo = new ConsentRepository(conn)

    await conn.query('BEGIN')
    await repo.insertRecord(conn, {
      employeeId: 'emp-1', consentFormId: form.id, purpose: 'biometric', state: 'granted',
      langShown: 'th', decidedAt: '2026-08-01T00:00:00.000Z', formTextSnapshot: Buffer.from('ct-1'),
    })
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    await repo.insertRecord(conn, {
      employeeId: 'emp-1', consentFormId: form.id, purpose: 'biometric', state: 'withdrawn',
      langShown: 'th', decidedAt: '2026-09-01T00:00:00.000Z', formTextSnapshot: Buffer.from('ct-2'),
    })
    await conn.query('COMMIT')

    const records = await repo.findRecordsByEmployeeAndPurpose('emp-1', 'biometric')
    expect(records).toHaveLength(2)
    expect(records[0]?.state).toBe('withdrawn') // most recent first
    expect(records[1]?.state).toBe('granted')
  })

  it('rejects an invalid state — CHECK (state IN (granted, refused, withdrawn))', async () => {
    const db = new FakeOnboardingDb()
    const form = db.seedConsentForm({ purpose: 'biometric', lang: 'th', version: 1, body_text: 'text' })
    const conn = db.connect()
    const repo = new ConsentRepository(conn)

    await expect(
      repo.insertRecord(conn, {
        employeeId: 'emp-1', consentFormId: form.id, purpose: 'biometric',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately an invalid value to prove the CHECK constraint
        state: 'bogus' as any,
        langShown: 'th', decidedAt: '2026-08-01T00:00:00.000Z', formTextSnapshot: Buffer.from('ct'),
      }),
    ).rejects.toThrow(ConstraintViolation)
  })

  it('a rolled-back insertRecord() is not visible after ROLLBACK', async () => {
    const db = new FakeOnboardingDb()
    const form = db.seedConsentForm({ purpose: 'biometric', lang: 'th', version: 1, body_text: 'text' })
    const conn = db.connect()
    const repo = new ConsentRepository(conn)

    await conn.query('BEGIN')
    await repo.insertRecord(conn, {
      employeeId: 'emp-1', consentFormId: form.id, purpose: 'biometric', state: 'granted',
      langShown: 'th', decidedAt: '2026-08-01T00:00:00.000Z', formTextSnapshot: Buffer.from('ct'),
    })
    await conn.query('ROLLBACK')

    expect(await repo.findRecordsByEmployeeAndPurpose('emp-1', 'biometric')).toHaveLength(0)
  })
})
