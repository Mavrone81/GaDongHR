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

function guardWith(decision: Decision | Error): PermissionGuard {
  const transport: AuthzTransport = {
    post: jest.fn(() => (decision instanceof Error ? Promise.reject(decision) : Promise.resolve(decision))),
  }
  return new PermissionGuard(new AuthzClient(transport))
}

describe('PermissionGuard', () => {
  it('denies a route with no @RequirePermission — deny-by-default must be structural', async () => {
    const guard = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
    const controller = new FakeController()
    const context = fakeContext(controller.unannotated, FakeController, { userId: 'user-1' })

    await expect(guard.canActivate(context)).rejects.toThrow(GadongError)
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUZ-403' })
  })

  it('throws AUZ-403 with the permission name in details when svc-authz denies', async () => {
    const guard = guardWith({ allowed: false, scopeOrgUnitIds: [] })
    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1' })

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'AUZ-403',
      details: [{ permission: 'employee.read' }],
    })
  })

  it('allows the request when svc-authz grants the permission', async () => {
    const guard = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1' })

    await expect(guard.canActivate(context)).resolves.toBe(true)
  })

  it('denies when svc-authz is unreachable — an authz outage must never become a bypass', async () => {
    const guard = guardWith(new Error('ECONNREFUSED'))
    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, { userId: 'user-1' })

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUZ-403' })
  })

  it('implements CanActivate', () => {
    const guard = guardWith({ allowed: true, scopeOrgUnitIds: '*' })
    const asCanActivate: CanActivate = guard
    expect(typeof asCanActivate.canActivate).toBe('function')
  })
})
