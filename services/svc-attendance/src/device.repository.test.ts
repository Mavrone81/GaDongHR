import { randomUUID } from 'node:crypto'
import { DeviceRepository } from './device.repository'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

describe('DeviceRepository', () => {
  it('inserts a device as pending, encrypted secret stored as-given (encryption happens at the service layer)', async () => {
    const db = new FakeAttendanceDb()
    const repo = new DeviceRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const row = await repo.insert(tx, { id: randomUUID(), kind: 'kiosk', siteCode: 'BKK-HQ', deviceSecret: Buffer.from('ciphertext'), registeredBy: 'hr-1' })
    await tx.query('COMMIT')

    expect(row).toMatchObject({ kind: 'kiosk', siteCode: 'BKK-HQ', status: 'pending', registeredBy: 'hr-1', approvedBy: null })
  })

  it('approve flips status to active and stamps approvedBy/approvedAt', async () => {
    const db = new FakeAttendanceDb()
    const repo = new DeviceRepository(db.asPool())
    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const device = await repo.insert(tx1, { id: randomUUID(), kind: 'kiosk', siteCode: 'BKK-HQ', deviceSecret: Buffer.from('ct'), registeredBy: 'hr-1' })
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const approved = await repo.approve(tx2, device.id, 'hr-2', '2026-01-01T00:00:00.000Z')
    await tx2.query('COMMIT')

    expect(approved).toMatchObject({ status: 'active', approvedBy: 'hr-2', approvedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('rejects an unrecognised kind via the CHECK constraint', async () => {
    const db = new FakeAttendanceDb()
    const repo = new DeviceRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the type system to prove the fake enforces the DB-level CHECK.
    await expect(repo.insert(tx, { id: randomUUID(), kind: 'wearable' as any, siteCode: 'BKK-HQ', deviceSecret: Buffer.from('ct'), registeredBy: 'hr-1' })).rejects.toThrow(
      /device_kind_check/,
    )
  })
})
