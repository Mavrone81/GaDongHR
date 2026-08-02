import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { permissionDenied } from '../errors'
import { AuthzClient } from './client'

/**
 * Maps a controller method (the exact function reference Nest hands back
 * from `context.getHandler()`) to the one permission it requires. A plain
 * `WeakMap` keyed on the method itself — rather than Nest's
 * `SetMetadata`/`Reflector` (which needs the `reflect-metadata` polyfill
 * loaded as a side effect before any decorator runs) — keeps this module
 * self-contained: `@nestjs/common` is used for its types only, nothing in
 * this file requires it at runtime.
 */
const requiredPermissions = new WeakMap<object, string>()

/**
 * `RequirePermission('employee.read')` on a controller method. There is
 * deliberately no way to mark a method "public" — the guard denies any
 * method this decorator was never applied to (see `PermissionGuard` below).
 */
export function RequirePermission(permission: string): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const handler = descriptor.value as unknown as object | undefined
    if (handler) requiredPermissions.set(handler, permission)
    return descriptor
  }
}

/** The minimum a request object must carry for the guard to ask svc-authz. */
export interface AuthenticatedRequest {
  userId: string
}

/**
 * Reads the permission `@RequirePermission` attached to the handler, asks
 * `AuthzClient` for a decision, and throws `permissionDenied()` (AUZ-403)
 * unless the decision is an explicit grant.
 *
 * Deny-by-default is structural here, not conventional: a handler with no
 * `@RequirePermission` at all has no entry in `requiredPermissions`, so
 * `permission` is `undefined` and the guard throws before `AuthzClient` is
 * even consulted — there is no code path from "unannotated" to "allowed"
 * (carried-forward binding note; this is the single most important test in
 * this task).
 */
export class PermissionGuard implements CanActivate {
  constructor(private readonly authzClient: AuthzClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = requiredPermissions.get(context.getHandler())
    if (!permission) {
      throw permissionDenied('(unannotated route)')
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const decision = await this.authzClient.decide(request.userId, permission)

    if (!decision.allowed) {
      throw permissionDenied(permission)
    }

    return true
  }
}
