import 'reflect-metadata'
import { createHmac } from 'node:crypto'
import { canonicalJson, CryptoClient, AuditEmitter } from '@gadong/kernel'
import type { ExecutionContext } from '@nestjs/common'
import { DeviceService } from './device.service'
import { DeviceRepository } from './device.repository'
import { DEVICE_AUTH_METADATA_KEY, DeviceAuthGuard } from './device-auth.guard'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

/**
 * A context for a route carrying `@DeviceAuthenticated()` — i.e. the two
 * kiosk punch routes. `deviceAuthenticated: false` builds the opposite: an
 * ordinary human-facing route, on which this guard must be a no-op now that
 * it is mounted globally (see `device-auth.guard.ts`'s header).
 */
function fakeContext(
  request: { userId?: string; headers: Record<string, string>; body: unknown },
  deviceAuthenticated = true,
): ExecutionContext {
  const handler = (): void => {}
  class FakeController {}
  if (deviceAuthenticated) Reflect.defineMetadata(DEVICE_AUTH_METADATA_KEY, true, handler)
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => FakeController,
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

  /**
   * The half of the contract that makes global mounting safe. This guard is
   * now the FIRST of two `APP_GUARD`s, so it sees every request in the
   * service — including `/enrolments/*`, `/devices/*`, `/security-events`
   * and `/health`. On those it must neither authenticate nor reject: it
   * steps aside and `PermissionGuard` (the second `APP_GUARD`) decides.
   */
  describe('routes NOT marked @DeviceAuthenticated() — global mounting must not change them', () => {
    it('is a no-op on an unmarked route: no device headers required, no userId stamped', async () => {
      const db = new FakeAttendanceDb()
      const deviceService = new DeviceService(new DeviceRepository(db.asPool()), new CryptoClient(fakeCryptoTransport()), new AuditEmitter())
      const guard = new DeviceAuthGuard(deviceService, db.asPool() as unknown as import('pg').Pool)
      const request: { userId?: string; headers: Record<string, string>; body: unknown } = { headers: {}, body: {} }

      await expect(guard.canActivate(fakeContext(request, false))).resolves.toBe(true)
      // Critically: it does NOT invent a principal. `PermissionGuard`'s
      // `!request.userId` deny path is still reached for an unauthenticated
      // caller — this guard returning `true` is "no opinion", not "allow".
      expect(request.userId).toBeUndefined()
    })

    it('ignores device headers on an unmarked route rather than authenticating against them', async () => {
      const db = new FakeAttendanceDb()
      const deviceService = new DeviceService(new DeviceRepository(db.asPool()), new CryptoClient(fakeCryptoTransport()), new AuditEmitter())
      const guard = new DeviceAuthGuard(deviceService, db.asPool() as unknown as import('pg').Pool)
      // A well-formed-looking but entirely unverified device header pair.
      // On a marked route this would be checked (and rejected, ATT-030); on
      // an unmarked one it must not be a way to acquire a device principal.
      const request: { userId?: string; headers: Record<string, string>; body: unknown } = {
        headers: { 'x-device-id': 'not-a-real-device', 'x-device-signature': 'deadbeef' },
        body: {},
      }

      await expect(guard.canActivate(fakeContext(request, false))).resolves.toBe(true)
      expect(request.userId).toBeUndefined()
    })
  })
})
