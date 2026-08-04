import { createHmac } from 'node:crypto'
import { canonicalJson, CryptoClient, AuditEmitter } from '@gadong/kernel'
import type { ExecutionContext } from '@nestjs/common'
import { DeviceService } from './device.service'
import { DeviceRepository } from './device.repository'
import { DeviceAuthGuard } from './device-auth.guard'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

function fakeContext(request: { userId?: string; headers: Record<string, string>; body: unknown }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
}

describe('DeviceAuthGuard', () => {
  it('allows an active device with a correct signature and stamps request.userId', async () => {
    const db = new FakeAttendanceDb()
    const deviceService = new DeviceService(new DeviceRepository(db.asPool()), new CryptoClient(fakeCryptoTransport()), new AuditEmitter())
    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const device = await deviceService.register(tx1, { kind: 'kiosk', siteCode: 'BKK-HQ', secret: 'shared-secret' }, 'hr-1', 'hr_admin')
    await tx1.query('COMMIT')
    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await deviceService.approve(tx2, device.id, 'hr-2', 'hr_admin')
    await tx2.query('COMMIT')

    const guard = new DeviceAuthGuard(deviceService, db.asPool() as unknown as import('pg').Pool)
    const body = { idemKey: 'device-1:seq-1' }
    const signature = createHmac('sha256', 'shared-secret').update(Buffer.from(canonicalJson(body), 'utf8')).digest('hex')
    const request: { userId?: string; headers: Record<string, string>; body: unknown } = { headers: { 'x-device-id': device.id, 'x-device-signature': signature }, body }
    const context = fakeContext(request)

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(request.userId).toBe(`device:${device.id}`)
  })

  it('rejects a missing device-id/signature header pair without calling the device service', async () => {
    const db = new FakeAttendanceDb()
    const deviceService = new DeviceService(new DeviceRepository(db.asPool()), new CryptoClient(fakeCryptoTransport()), new AuditEmitter())
    const guard = new DeviceAuthGuard(deviceService, db.asPool() as unknown as import('pg').Pool)
    const context = fakeContext({ headers: {}, body: {} })
    await expect(guard.canActivate(context)).resolves.toBe(false)
  })

  it('rejects a wrong signature (ATT-030)', async () => {
    const db = new FakeAttendanceDb()
    const deviceService = new DeviceService(new DeviceRepository(db.asPool()), new CryptoClient(fakeCryptoTransport()), new AuditEmitter())
    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const device = await deviceService.register(tx1, { kind: 'kiosk', siteCode: 'BKK-HQ', secret: 'shared-secret' }, 'hr-1', 'hr_admin')
    await tx1.query('COMMIT')
    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await deviceService.approve(tx2, device.id, 'hr-2', 'hr_admin')
    await tx2.query('COMMIT')

    const guard = new DeviceAuthGuard(deviceService, db.asPool() as unknown as import('pg').Pool)
    const context = fakeContext({ headers: { 'x-device-id': device.id, 'x-device-signature': 'deadbeef' }, body: {} })
    await expect(guard.canActivate(context)).rejects.toThrow(/ATT-030/)
  })
})
