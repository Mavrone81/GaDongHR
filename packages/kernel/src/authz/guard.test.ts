import 'reflect-metadata'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { GadongError } from '../errors'
import type { Queryable } from '../outbox/outbox'
import { AuthzClient } from './client'
import type { AuthzTransport, Decision } from './client'
import { Public, PermissionGuard, RequirePermission } from './guard'
import type { DenialAuditSink } from './guard'

/**
 * Minimal stand-in for Nest's ExecutionContext. Only the members
 * PermissionGuard actually reads are implemented meaningfully; the rest
 * throw if touched, so a test that accidentally relies on unimplemented
 * behaviour fails loudly instead of silently returning `undefined`.
 */
function fakeContext(handler: () => void, controllerClass: new () => unknown, request: unknown): ExecutionContext {
  const notImplemented = () => {
    throw new Error('not implemented in fakeContext')
  }
  return {
    getHandler: () => handler,
    getClass: () => controllerClass,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: notImplemented,
      getNext: notImplemented,
    }),
    switchToRpc: notImplemented,
    switchToWs: notImplemented,
    getArgs: notImplemented,
    getArgByIndex: notImplemented,
    getType: notImplemented,
  } as unknown as ExecutionContext
}

class FakeController {
  @RequirePermission('employee.read')
  annotated(): void {
    /* no-op */
  }

  unannotated(): void {
    /* no-op */
  }
}

/** A method decorator applied ABOVE (i.e. composed after) `@RequirePermission`, which replaces `descriptor.value` with a new function object — proving metadata attached to the original handler does not silently transfer to whatever `getHandler()` returns after composition. */
function WrapsHandler(): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown
    descriptor.value = function wrapped(this: unknown, ...args: unknown[]): unknown {
      return original.apply(this, args)
    } as typeof descriptor.value
    return descriptor
  }
}

class WrappedController {
  @WrapsHandler()
  @RequirePermission('employee.read')
  wrapped(): void {
    /* no-op */
  }
}

@RequirePermission('employee.read')
class ClassLevelController {
  annotatedAtClassLevel(): void {
    /* no-op */
  }
}

class PublicController {
  @Public()
  health(): void {
    /* no-op */
  }

  unannotated(): void {
    /* no-op */
  }
}

@Public()
class ClassLevelPublicController {
  publicAtClassLevel(): void {
    /* no-op */
  }
}

class WrappedPublicController {
  @WrapsHandler()
  @Public()
  wrappedPublic(): void {
    /* no-op */
  }
}

function guardWith(decision: Decision | Error): { guard: PermissionGuard; post: jest.Mock } {
  const post = jest.fn(() => (decision instanceof Error ? Promise.reject(decision) : Promise.resolve(decision)))
  const transport: AuthzTransport = { post }
  return { guard: new PermissionGuard(new AuthzClient(transport)), post }
}

/** A `DenialAuditSink` backed by a `jest.fn()` `Queryable` — same minimal-mock pattern `outbox.test.ts` uses for `writeOutbox` itself, since a denial audit entry is just another `writeOutbox` call under the hood (via `AuditEmitter`). */
function fakeSink(query: jest.Mock = jest.fn().mockResolvedValue({ rows: [{ id: 'outbox-row-1' }] })): { sink: DenialAuditSink; query: jest.Mock } {
  const pool: Queryable = { query }
  return { sink: { pool, schema: 'payroll' }, query }
}

function guardWithSink(decision: Decision | Error, sink: DenialAuditSink): { guard: PermissionGuard; post: jest.Mock } {
  const post = jest.fn(() => (decision instanceof Error ? Promise.reject(decision) : Promise.resolve(decision)))
  const transport: AuthzTransport = { post }
  return { guard: new PermissionGuard(new AuthzClient(transport), sink), post }
}

describe('PermissionGuard', () => {
  it('denies a route with no @RequirePermission — deny-by-default must be structural', async () => {
    const { guard } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
    const controller = new FakeController()
    const context = fakeContext(controller.unannotated, FakeController, { userId: 'user-1' })

    await expect(guard.canActivate(context)).rejects.toThrow(GadongError)
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'AUZ-403',
      details: [{ reason: 'no_permission_declared' }],
    })
  })

  it('throws AUZ-403 with the permission name in details when svc-authz denies', async () => {
    const { guard } = guardWith({ allowed: false, scopeOrgUnitIds: [] })
    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1' })

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'AUZ-403',
      details: [{ permission: 'employee.read' }],
    })
  })

  it('allows the request when svc-authz grants the permission', async () => {
    const { guard } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1' })

    await expect(guard.canActivate(context)).resolves.toBe(true)
  })

  it('denies when svc-authz is unreachable — an authz outage must never become a bypass', async () => {
    const { guard } = guardWith(new Error('ECONNREFUSED'))
    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1' })

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUZ-403' })
  })

  it('implements CanActivate', () => {
    const { guard } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
    const asCanActivate: CanActivate = guard
    expect(typeof asCanActivate.canActivate).toBe('function')
  })

  it('denies locally, without calling svc-authz, when the request has no authenticated userId (fix round 1, IMPORTANT 4)', async () => {
    const { guard, post } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, {}) // no userId

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUZ-403' })
    expect(post).not.toHaveBeenCalled()
  })

  it('is annotated with @Injectable so Nest DI can resolve it for an APP_GUARD registration (fix round 1, IMPORTANT 3)', () => {
    // Mirrors what @nestjs/common's own Injectable() decorator writes,
    // and what Nest's DI container checks for at module-compile time.
    expect(Reflect.getMetadata('__injectable__', PermissionGuard)).toBe(true)
  })

  it('supports a class-level @RequirePermission (the WeakMap-keyed-on-handler mechanism could not) (fix round 1, D1)', async () => {
    const { guard } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
    const controller = new ClassLevelController()
    const context = fakeContext(controller.annotatedAtClassLevel, ClassLevelController, { userId: 'user-1' })

    await expect(guard.canActivate(context)).resolves.toBe(true)
  })

  it('fails closed (denies) when a composed decorator replaces the descriptor value above @RequirePermission (fix round 1, D1)', async () => {
    const { guard } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
    const controller = new WrappedController()
    const context = fakeContext(controller.wrapped, WrappedController, { userId: 'user-1' })

    // The final handler `getHandler()` returns is the wrapper's new
    // function object, which never received the metadata `RequirePermission`
    // attached to the original — so this must deny, not silently allow.
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'AUZ-403',
      details: [{ reason: 'no_permission_declared' }],
    })
  })

  describe('@Public() (Task 16e)', () => {
    it('allows a @Public() route with no authenticated principal at all — no userId, no AuthzClient call', async () => {
      const { guard, post } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
      const controller = new PublicController()
      const context = fakeContext(controller.health, PublicController, {}) // no userId

      await expect(guard.canActivate(context)).resolves.toBe(true)
      expect(post).not.toHaveBeenCalled()
    })

    it('supports a class-level @Public()', async () => {
      const { guard } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
      const controller = new ClassLevelPublicController()
      const context = fakeContext(controller.publicAtClassLevel, ClassLevelPublicController, {})

      await expect(guard.canActivate(context)).resolves.toBe(true)
    })

    it('a @Public() route on the SAME controller as an unannotated route does not make the unannotated route public', async () => {
      const { guard } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
      const controller = new PublicController()
      const context = fakeContext(controller.unannotated, PublicController, { userId: 'user-1' })

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: 'AUZ-403',
        details: [{ reason: 'no_permission_declared' }],
      })
    })

    it('fails closed (denies) when a composed decorator replaces the descriptor value above @Public() — the same property @RequirePermission relies on', async () => {
      const { guard } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
      const controller = new WrappedPublicController()
      const context = fakeContext(controller.wrappedPublic, WrappedPublicController, {})

      // The final handler `getHandler()` returns never received the
      // `@Public()` metadata attached to the original — so this must deny,
      // not silently allow. Weakening deny-by-default here would be exactly
      // the kind of accidental bypass the brief forbids.
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: 'AUZ-403',
        details: [{ reason: 'no_permission_declared' }],
      })
    })
  })

  describe('denial auditing (roadmap: "authz denials" must reach the audit trail)', () => {
    it('does nothing — no DB write attempted — when no sink was wired (the default for most services today)', async () => {
      const { guard } = guardWith({ allowed: false, scopeOrgUnitIds: [] })
      const controller = new FakeController()
      const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1' })

      await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUZ-403' })
      // No sink means no Queryable exists to assert against; the absence of
      // a thrown/unhandled error above (fakeContext's other methods all
      // throw if touched) is itself the proof nothing extra happened.
    })

    it('writes an audit.authz.denied outbox row, through the sink, when svc-authz denies the permission', async () => {
      const { sink, query } = fakeSink()
      const { guard } = guardWithSink({ allowed: false, scopeOrgUnitIds: [] }, sink)
      const controller = new FakeController()
      const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1', actorRole: 'employee' })

      await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUZ-403' })

      expect(query).toHaveBeenCalledTimes(1)
      const [sql, params] = (query.mock.calls[0] as [string, unknown[]])
      expect(sql).toMatch(/INSERT INTO/i)
      expect(sql).toMatch(/payroll\.outbox/i)
      expect(params[0]).toBe('audit.authz.denied')
      const payload = JSON.parse(params[1] as string) as Record<string, unknown>
      expect(payload).toMatchObject({
        actorId: 'user-1',
        actorRole: 'employee',
        action: 'authz.denied',
        entity: 'permission',
        entityId: 'employee.read',
        beforeHash: null,
        afterHash: null,
      })
    })

    it('writes the denial entry for an unauthenticated caller too, with actorId "unknown"', async () => {
      const { sink, query } = fakeSink()
      const { guard, post } = guardWithSink({ allowed: true, scopeOrgUnitIds: '*' }, sink)
      const controller = new FakeController()
      const context = fakeContext(controller.annotated, FakeController, {}) // no userId

      await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUZ-403' })

      expect(post).not.toHaveBeenCalled() // still denies locally, without asking svc-authz
      expect(query).toHaveBeenCalledTimes(1)
      const [, unauthenticatedParams] = query.mock.calls[0] as [string, unknown[]]
      const payload = JSON.parse(unauthenticatedParams[1] as string) as Record<string, unknown>
      expect(payload).toMatchObject({ actorId: 'unknown', actorRole: 'unknown', action: 'authz.denied' })
    })

    it('does not audit an allowed request — only denials are audited', async () => {
      const { sink, query } = fakeSink()
      const { guard } = guardWithSink({ allowed: true, scopeOrgUnitIds: '*' }, sink)
      const controller = new FakeController()
      const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1' })

      await expect(guard.canActivate(context)).resolves.toBe(true)
      expect(query).not.toHaveBeenCalled()
    })

    it('FAIL-OPEN-LOG: a broken audit sink still lets the real AUZ-403 denial through, not a 500', async () => {
      const { sink } = fakeSink(jest.fn().mockRejectedValue(new Error('ECONNREFUSED: payroll db down')))
      const { guard } = guardWithSink({ allowed: false, scopeOrgUnitIds: [] }, sink)
      const controller = new FakeController()
      const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1' })

      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        await expect(guard.canActivate(context)).rejects.toMatchObject({
          code: 'AUZ-403',
          details: [{ permission: 'employee.read' }],
        })
        expect(consoleError).toHaveBeenCalled()
      } finally {
        consoleError.mockRestore()
      }
    })
  })
})
