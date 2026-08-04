import { hashLookupCode, hashPin } from './credential-hash'
import { AlternativeCredentialRepository } from './alternative-credential.repository'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

const PEPPER = 'test-pepper-not-for-production'

describe('AlternativeCredentialRepository', () => {
  it('stores a hash, never the raw PIN', async () => {
    const db = new FakeAttendanceDb()
    const repo = new AlternativeCredentialRepository(db.asPool())
    const hash = hashPin(PEPPER, 'emp-1', '1234')
    const tx = db.connect()
    await tx.query('BEGIN')
    const row = await repo.upsert(tx, 'emp-1', 'pin', hash)
    await tx.query('COMMIT')

    expect(row.credentialHash).toEqual(hash)
    expect(row.credentialHash.toString('utf8')).not.toContain('1234')
  })

  it('findByHash resolves a scanned QR/badge code to exactly the one employee it was issued to', async () => {
    const db = new FakeAttendanceDb()
    const repo = new AlternativeCredentialRepository(db.asPool())
    const hash = hashLookupCode(PEPPER, 'badge', 'BADGE-0042')
    const tx = db.connect()
    await tx.query('BEGIN')
    await repo.upsert(tx, 'emp-1', 'badge', hash)
    await tx.query('COMMIT')

    const found = await repo.findByHash(db.asPool(), hash)
    expect(found?.employeeId).toBe('emp-1')

    const notFound = await repo.findByHash(db.asPool(), hashLookupCode(PEPPER, 'badge', 'BADGE-9999'))
    expect(notFound).toBeNull()
  })

  it('two different employees issued the same badge code collide on the UNIQUE hash constraint', async () => {
    const db = new FakeAttendanceDb()
    const repo = new AlternativeCredentialRepository(db.asPool())
    const hash = hashLookupCode(PEPPER, 'badge', 'BADGE-0042')

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await repo.upsert(tx1, 'emp-1', 'badge', hash)
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(repo.upsert(tx2, 'emp-2', 'badge', hash)).rejects.toThrow(/alternative_credential_hash_key/)
  })

  it('two different employees may independently choose the same PIN without colliding (employee id folded into the hash)', async () => {
    const db = new FakeAttendanceDb()
    const repo = new AlternativeCredentialRepository(db.asPool())

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await repo.upsert(tx1, 'emp-1', 'pin', hashPin(PEPPER, 'emp-1', '1234'))
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(repo.upsert(tx2, 'emp-2', 'pin', hashPin(PEPPER, 'emp-2', '1234'))).resolves.toBeDefined()
  })
})
