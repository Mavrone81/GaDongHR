import 'reflect-metadata'
import { HttpException } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { GadongError, PERMISSION_METADATA_KEY } from '@gadong/kernel'
import type { EncryptRequest } from '@gadong/kernel'
import { CryptoController } from './crypto.controller'
import { AppModule } from './app.module'
import type { CryptoService } from './crypto.service'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Only the surface CryptoController actually calls. */
type FakeCryptoService = Pick<CryptoService, 'encryptBatch' | 'decrypt' | 'bidx' | 'health'>

function fakeService(overrides: Partial<FakeCryptoService> = {}): CryptoService {
  const base: FakeCryptoService = {
    encryptBatch: jest.fn().mockResolvedValue({}),
    decrypt: jest.fn().mockResolvedValue('plaintext'),
    bidx: jest.fn().mockResolvedValue(Buffer.alloc(32, 1).toString('base64')),
    health: jest.fn().mockResolvedValue('up'),
    ...overrides,
  }
  return base as CryptoService
}

describe('CryptoController wiring', () => {
  it('POST /encrypt forwards body.fields and wraps the result as {fields}', async () => {
    const encryptBatch = jest.fn().mockResolvedValue({ national_id: 'Y2lwaGVy' })
    const svc = fakeService({ encryptBatch })
    const controller = new CryptoController(svc)
    const fields: EncryptRequest[] = [{ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }]

    const out = await controller.encrypt({ fields })

    expect(encryptBatch).toHaveBeenCalledWith(fields)
    expect(out).toEqual({ fields: { national_id: 'Y2lwaGVy' } })
  })

  it('POST /decrypt forwards entityId, field, ciphertext, purpose and wraps the result as {value}', async () => {
    const decrypt = jest.fn().mockResolvedValue('1101700207364')
    const svc = fakeService({ decrypt })
    const controller = new CryptoController(svc)

    const out = await controller.decrypt({
      entityId: 'emp-1',
      field: 'national_id',
      ciphertext: 'Y2lwaGVy',
      purpose: 'payroll_sso_filing',
    })

    expect(decrypt).toHaveBeenCalledWith('emp-1', 'national_id', 'Y2lwaGVy', 'payroll_sso_filing')
    expect(out).toEqual({ value: '1101700207364' })
  })

  it('POST /bidx forwards fieldClass, field, value and wraps the result as {bidx}', async () => {
    const bidxValue = Buffer.alloc(32, 3).toString('base64')
    const bidx = jest.fn().mockResolvedValue(bidxValue)
    const svc = fakeService({ bidx })
    const controller = new CryptoController(svc)

    const out = await controller.bidx({ fieldClass: 'S3', field: 'national_id', value: '1101700207364' })

    expect(bidx).toHaveBeenCalledWith('S3', 'national_id', '1101700207364')
    expect(out).toEqual({ bidx: bidxValue })
  })

  it('GET /health reports vault:up as overall status ok', async () => {
    const svc = fakeService({ health: jest.fn().mockResolvedValue('up') })
    const controller = new CryptoController(svc)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'ok', service: 'svc-crypto', dependencies: { vault: 'up' } })
  })

  it('GET /health reports vault:down as overall status degraded — not a crash', async () => {
    const svc = fakeService({ health: jest.fn().mockResolvedValue('down') })
    const controller = new CryptoController(svc)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', service: 'svc-crypto', dependencies: { vault: 'down' } })
  })

  it('maps a thrown GadongError to an HttpException carrying the error envelope and status', async () => {
    const err = new GadongError('CRY-503', 'crypto.error.unavailable', 503)
    const svc = fakeService({ decrypt: jest.fn().mockRejectedValue(err) })
    const controller = new CryptoController(svc)

    await expect(
      controller.decrypt({ entityId: 'e', field: 'f', ciphertext: 'Y3Q=', purpose: 'p' }),
    ).rejects.toBeInstanceOf(HttpException)

    try {
      await controller.decrypt({ entityId: 'e', field: 'f', ciphertext: 'Y3Q=', purpose: 'p' })
      throw new Error('expected rejection')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(HttpException)
      const httpErr = thrown as HttpException
      expect(httpErr.getStatus()).toBe(503)
      expect(httpErr.getResponse()).toEqual({ code: 'CRY-503', message_i18n_key: 'crypto.error.unavailable', details: [] })
    }
  })

  it('maps the CRY-400 blank-purpose error from CryptoService.decrypt to a 400 HttpException', async () => {
    const err = new GadongError('CRY-400', 'crypto.error.purpose_required', 400)
    const svc = fakeService({ decrypt: jest.fn().mockRejectedValue(err) })
    const controller = new CryptoController(svc)

    try {
      await controller.decrypt({ entityId: 'e', field: 'f', ciphertext: 'Y3Q=', purpose: '' })
      throw new Error('expected rejection')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(HttpException)
      expect((thrown as HttpException).getStatus()).toBe(400)
    }
  })
})

/**
 * "svc-crypto has no `@RequirePermission` routes — it is called
 * service-to-service, not by users." (Task 6 brief §3). This is the one
 * service where an unannotated route is correct; these tests are the
 * guardrail against a future reader "fixing" that.
 */
describe('CryptoController deliberately declares no permissions', () => {
  it('has no @RequirePermission metadata on the controller class', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, CryptoController)).toBeUndefined()
  })

  it.each(['encrypt', 'decrypt', 'bidx', 'health'])('has no @RequirePermission metadata on %s()', (method) => {
    const proto = CryptoController.prototype as unknown as Record<string, () => unknown>
    const handler = proto[method]
    if (!handler) throw new Error(`no such handler: ${method}`)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })
})

describe('AppModule does not mount the kernel PermissionGuard', () => {
  it('registers no APP_GUARD provider', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const hasAppGuard = providers.some((p) => isRecord(p) && p['provide'] === APP_GUARD)
    expect(hasAppGuard).toBe(false)
  })
})
