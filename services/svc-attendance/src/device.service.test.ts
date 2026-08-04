import { createHmac } from 'node:crypto'
import { AuditEmitter, CryptoClient } from '@gadong/kernel'
import { DeviceRepository } from './device.repository'
import { DeviceService } from './device.service'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

function buildService(db: FakeAttendanceDb) {
  return new DeviceService(new DeviceRepository(db.asPool()), new CryptoClient(fakeCryptoTransport()), new AuditEmitter())
}

describe('DeviceService.register', () => {
  it('stores the device secret encrypted, never in plaintext', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    const tx = db.connect()
    await tx.query('BEGIN')
    const device = await service.register(tx, { kind: 'kiosk', siteCode: 'BKK-HQ', secret: 'super-secret-hmac-key' }, 'hr-1', 'hr_admin')
    await tx.query('COMMIT')

    expect(device.status).toBe('pending')
    expect(device.deviceSecret.toString('utf8')).not.toContain('super-secret-hmac-key')
  })
})

describe('DeviceService.approve — second-person approval (segregation of duties)', () => {
  it('the SAME actor who registered a device cannot approve it', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const device = await service.register(tx1, { kind: 'kiosk', siteCode: 'BKK-HQ', secret: 's3cret' }, 'hr-1', 'hr_admin')
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(service.approve(tx2, device.id, 'hr-1', 'hr_admin')).rejects.toThrow(/ATT-031|second_person/i)
  })

  it('a DIFFERENT actor approving flips the device to active', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const device = await service.register(tx1, { kind: 'kiosk', siteCode: 'BKK-HQ', secret: 's3cret' }, 'hr-1', 'hr_admin')
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const approved = await service.approve(tx2, device.id, 'hr-2', 'hr_admin')
    await tx2.query('COMMIT')

    expect(approved).toMatchObject({ status: 'active', approvedBy: 'hr-2' })
  })
})

describe('DeviceService.verifySignature — kiosk HMAC auth', () => {
  it('accepts a correctly signed payload from an approved device', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const device = await service.register(tx1, { kind: 'kiosk', siteCode: 'BKK-HQ', secret: 'shared-secret' }, 'hr-1', 'hr_admin')
    await tx1.query('COMMIT')
    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await service.approve(tx2, device.id, 'hr-2', 'hr_admin')
    await tx2.query('COMMIT')

    const payload = Buffer.from('idem_key=device-1:seq-1')
    const signature = createHmac('sha256', 'shared-secret').update(payload).digest('hex')

    await expect(service.verifySignature(db.asPool(), device.id, payload, signature)).resolves.toMatchObject({ id: device.id })
  })

  it('rejects a wrong signature', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const device = await service.register(tx1, { kind: 'kiosk', siteCode: 'BKK-HQ', secret: 'shared-secret' }, 'hr-1', 'hr_admin')
    await tx1.query('COMMIT')
    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await service.approve(tx2, device.id, 'hr-2', 'hr_admin')
    await tx2.query('COMMIT')

    await expect(service.verifySignature(db.asPool(), device.id, Buffer.from('payload'), 'deadbeef')).rejects.toThrow(/ATT-030/)
  })

  it('rejects a still-pending (not yet approved) device even with a correct signature', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    const tx = db.connect()
    await tx.query('BEGIN')
    const device = await service.register(tx, { kind: 'kiosk', siteCode: 'BKK-HQ', secret: 'shared-secret' }, 'hr-1', 'hr_admin')
    await tx.query('COMMIT')

    const payload = Buffer.from('payload')
    const signature = createHmac('sha256', 'shared-secret').update(payload).digest('hex')
    await expect(service.verifySignature(db.asPool(), device.id, payload, signature)).rejects.toThrow(/ATT-030/)
  })

  it('rejects an unknown device id', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    await expect(service.verifySignature(db.asPool(), 'nonexistent', Buffer.from('x'), 'deadbeef')).rejects.toThrow(/ATT-030/)
  })
})
