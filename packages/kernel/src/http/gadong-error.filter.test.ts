import 'reflect-metadata'
import { Controller, Get, Module } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { GadongError } from '../errors'
import { GadongErrorFilter } from './gadong-error.filter'

/**
 * A tiny, self-contained Nest app — not any real service's `AppModule` —
 * built purely so this test can issue REAL HTTP requests through the whole
 * Nest pipeline (routing → handler throw → exception filter → HTTP
 * response), the only way to actually prove "a thrown GadongError produces
 * this HTTP status with this body", as opposed to merely calling
 * `filter.catch(...)` directly against a hand-built fake `ArgumentsHost`.
 */
function throwsForbidden(): never {
  throw new GadongError('AUZ-403', 'authz.error.denied', 403, [{ permission: 'employee.read' }])
}
function throwsUnavailable(): never {
  throw new GadongError('CRY-503', 'crypto.error.unavailable', 503)
}
const SECRET_DETAIL = 'super secret internal stack detail that must never reach a client'
function throwsUnexpected(): never {
  throw new Error(SECRET_DETAIL)
}

@Controller()
class ProbeController {
  @Get('forbidden')
  forbidden(): void {
    throwsForbidden()
  }

  @Get('unavailable')
  unavailable(): void {
    throwsUnavailable()
  }

  @Get('boom')
  boom(): void {
    throwsUnexpected()
  }
}

@Module({
  controllers: [ProbeController],
  providers: [{ provide: APP_FILTER, useClass: GadongErrorFilter }],
})
class ProbeModule {}

interface TcpAddress {
  port: number
}

function isTcpAddress(v: unknown): v is TcpAddress {
  return typeof v === 'object' && v !== null && typeof (v as { port?: unknown }).port === 'number'
}

async function bootProbeApp(): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  await app.listen(0)
  const address: unknown = app.getHttpServer().address()
  if (!isTcpAddress(address)) throw new Error('gadong-error.filter.test: probe app did not bind a TCP port')
  return { app, baseUrl: `http://127.0.0.1:${address.port}` }
}

describe('GadongErrorFilter (Task 16e, defect 2)', () => {
  let app: INestApplication
  let baseUrl: string

  beforeEach(async () => {
    const booted = await bootProbeApp()
    app = booted.app
    baseUrl = booted.baseUrl
  })

  afterEach(async () => {
    await app.close()
  })

  it('maps a thrown GadongError with httpStatus 403 to a real HTTP 403 response carrying its {code, message_i18n_key, details} envelope', async () => {
    const res = await fetch(`${baseUrl}/forbidden`)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({
      code: 'AUZ-403',
      message_i18n_key: 'authz.error.denied',
      details: [{ permission: 'employee.read' }],
    })
  })

  it('maps a thrown GadongError with httpStatus 503 to a real HTTP 503 response carrying its envelope', async () => {
    const res = await fetch(`${baseUrl}/unavailable`)

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      code: 'CRY-503',
      message_i18n_key: 'crypto.error.unavailable',
      details: [],
    })
  })

  it('leaves an unexpected (non-GadongError) exception as Nest\'s ordinary 500 — this filter must not change that behaviour or leak the message', async () => {
    const res = await fetch(`${baseUrl}/boom`)

    expect(res.status).toBe(500)
    const bodyText = await res.text()
    expect(bodyText).not.toContain(SECRET_DETAIL)
  })
})
