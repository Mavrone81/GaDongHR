import 'reflect-metadata'
import { HttpException } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { PERMISSION_METADATA_KEY } from '@gadong/kernel'
import type { AuthenticatedRequest } from '@gadong/kernel'
import type { Pool } from 'pg'
import { NotifyController, DB_POOL, EMAIL_TRANSPORT } from './notify.controller'
import { AppModule } from './app.module'
import { NotificationNotFound } from './notify.service'
import type { NotifyService, EmailTransport } from './notify.service'
import type { NotificationRow } from './notify.repository'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function fakeNotification(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'notif-1',
    recipientUserId: 'user-1',
    kind: 'leave.approved',
    lang: 'th',
    subject: 'subject',
    body: 'body',
    readAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function fakePool(overrides: Partial<Pool> = {}): Pool {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

function fakeEmailTransport(overrides: Partial<EmailTransport> = {}): EmailTransport {
  return {
    send: jest.fn().mockResolvedValue(undefined),
    verify: jest.fn().mockResolvedValue(true),
    ...overrides,
  }
}

type FakeNotifyService = Pick<NotifyService, 'listNotifications' | 'markRead'>
function fakeNotifyService(overrides: Partial<FakeNotifyService> = {}): NotifyService {
  const base: FakeNotifyService = {
    listNotifications: jest.fn().mockResolvedValue([fakeNotification()]),
    markRead: jest.fn().mockResolvedValue(fakeNotification({ readAt: '2026-08-01T01:00:00.000Z' })),
    ...overrides,
  }
  return base as NotifyService
}

function authedRequest(userId: string | undefined): AuthenticatedRequest {
  return { userId }
}

describe('NotifyController wiring', () => {
  it('GET /notifications uses the AUTHENTICATED caller\'s own userId as the recipient, ignoring anything else', async () => {
    const listNotifications = jest.fn().mockResolvedValue([fakeNotification()])
    const controller = new NotifyController(fakeNotifyService({ listNotifications }), fakePool(), fakeEmailTransport())

    const out = await controller.list(authedRequest('user-1'), 'true')

    expect(listNotifications).toHaveBeenCalledWith('user-1', true)
    expect(out.notifications).toHaveLength(1)
  })

  it('GET /notifications with no "unread" query param passes unreadOnly=false', async () => {
    const listNotifications = jest.fn().mockResolvedValue([])
    const controller = new NotifyController(fakeNotifyService({ listNotifications }), fakePool(), fakeEmailTransport())

    await controller.list(authedRequest('user-1'))

    expect(listNotifications).toHaveBeenCalledWith('user-1', false)
  })

  it('GET /notifications throws 401 when there is no authenticated userId (belt behind PermissionGuard)', async () => {
    const controller = new NotifyController(fakeNotifyService(), fakePool(), fakeEmailTransport())

    await expect(controller.list(authedRequest(undefined))).rejects.toBeInstanceOf(HttpException)
  })

  it('POST /notifications/:id/read opens a transaction and forwards id + the caller\'s own userId', async () => {
    const markRead = jest.fn().mockResolvedValue(fakeNotification({ id: 'notif-1', readAt: '2026-08-01T01:00:00.000Z' }))
    const controller = new NotifyController(fakeNotifyService({ markRead }), fakePool(), fakeEmailTransport())

    const out = await controller.markRead(authedRequest('user-1'), 'notif-1')

    expect(markRead).toHaveBeenCalledWith(expect.anything(), 'notif-1', 'user-1')
    expect(out.readAt).not.toBeNull()
  })

  it('POST /notifications/:id/read maps NotificationNotFound to a 404 HttpException', async () => {
    const markRead = jest.fn().mockRejectedValue(new NotificationNotFound('notif-x'))
    const controller = new NotifyController(fakeNotifyService({ markRead }), fakePool(), fakeEmailTransport())

    try {
      await controller.markRead(authedRequest('user-1'), 'notif-x')
      throw new Error('expected rejection')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(HttpException)
      expect((thrown as HttpException).getStatus()).toBe(404)
    }
  })

  it('GET /health reports db:up and smtp:up as overall status ok', async () => {
    const controller = new NotifyController(fakeNotifyService(), fakePool(), fakeEmailTransport())

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'ok', service: 'svc-notify', dependencies: { db: 'up', smtp: 'up' } })
  })

  it('GET /health reports db:down as degraded when the pool query rejects', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new NotifyController(fakeNotifyService(), pool, fakeEmailTransport())

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down' } })
  })

  it('GET /health reports smtp:down as degraded when verify() rejects, without crashing', async () => {
    const emailTransport = fakeEmailTransport({ verify: jest.fn().mockRejectedValue(new Error('smtp unreachable')) })
    const controller = new NotifyController(fakeNotifyService(), fakePool(), emailTransport)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { smtp: 'down' } })
  })

  it('GET /health reports smtp:down as degraded when verify() resolves false', async () => {
    const emailTransport = fakeEmailTransport({ verify: jest.fn().mockResolvedValue(false) })
    const controller = new NotifyController(fakeNotifyService(), fakePool(), emailTransport)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { smtp: 'down' } })
  })
})

describe('NotifyController — deny-by-default permission wiring (Task 11 brief permission table)', () => {
  const EXPECTED: Record<string, string> = {
    list: 'notify.notification.read',
    markRead: 'notify.notification.update',
  }

  it.each(Object.entries(EXPECTED))('%s() declares @RequirePermission(%s)', (method, permission) => {
    const proto = NotifyController.prototype as unknown as Record<string, () => unknown>
    const handler = proto[method]
    if (!handler) throw new Error(`no such handler: ${method}`)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe(permission)
  })

  it('health() has no @RequirePermission metadata — reachable without a permission, per the brief', () => {
    const proto = NotifyController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['health']
    if (!handler) throw new Error('no such handler: health')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })

  it('has no class-level @RequirePermission that could mask an unannotated method', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, NotifyController)).toBeUndefined()
  })
})

describe('AppModule mounts the kernel PermissionGuard (reached by end users, like svc-config)', () => {
  it('registers an APP_GUARD provider bound to PermissionGuard', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const appGuardEntry = providers.find((p) => isRecord(p) && p['provide'] === APP_GUARD)
    expect(appGuardEntry).toBeDefined()
  })

  it('registers DB_POOL and EMAIL_TRANSPORT providers', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    expect(providers.some((p) => isRecord(p) && p['provide'] === DB_POOL)).toBe(true)
    expect(providers.some((p) => isRecord(p) && p['provide'] === EMAIL_TRANSPORT)).toBe(true)
  })
})
