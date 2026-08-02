import 'reflect-metadata'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { GadongError } from '../errors'
import { AuthzClient } from './client'
import type { AuthzTransport, Decision } from './client'
import { PermissionGuard, RequirePermission } from './guard'

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

function guardWith(decision: Decision | Error): { guard: PermissionGuard; post: jest.Mock } {
  const post = jest.fn(() => (decision instanceof Error ? Promise.reject(decision) : Promise.resolve(decision)))
  const transport: AuthzTransport = { post }
  return { guard: new PermissionGuard(new AuthzClient(transport)), post }
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
})
