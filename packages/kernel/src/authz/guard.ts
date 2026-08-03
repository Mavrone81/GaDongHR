import 'reflect-metadata'
import { Injectable, SetMetadata } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { GadongError, permissionDenied } from '../errors'
import { AuthzClient } from './client'

/**
 * Metadata key `@RequirePermission` writes and `PermissionGuard` reads,
 * using the exact mechanism Nest's own `Reflector` uses internally
 * (`SetMetadata` writes via `Reflect.defineMetadata`; reading it back with
 * `Reflect.getMetadata` is what `Reflector#get`/`#getAllAndOverride` do —
 * verified against Nest's own `paths-explorer.ts`/`guards-consumer.ts`
 * source). `@nestjs/common` and `reflect-metadata` are peer dependencies of
 * this package specifically so this works without needing `@nestjs/core`.
 *
 * Fix round 1, D1: the original mechanism (a module-local `WeakMap` keyed
 * on the handler function) was verified safe — it fails closed even under
 * decorator composition (see `guard.test.ts`'s wrapper-decorator case) —
 * but its stated justification was wrong: `reflect-metadata` and
 * `@nestjs/common` were already hard dependencies, so this standard
 * mechanism was available all along, without ever needing `@nestjs/core`.
 * Switching to it also (a) supports a class-level `@RequirePermission`,
 * which a handler-keyed `WeakMap` cannot; (b) stays visible to
 * `Reflector`-based tooling and future Nest middleware, since it is the
 * same metadata a real `Reflector` would read; and (c) survives two copies
 * of this module landing in one dependency graph, because the metadata
 * lives on the handler function itself via the process-wide `Reflect`
 * polyfill rather than in a module-local `WeakMap` instance.
 */
export const PERMISSION_METADATA_KEY = 'gadong:required-permission'

/**
 * `@RequirePermission('employee.read')` on a controller method, or on a
 * whole controller class.
 */
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_METADATA_KEY, permission)

/**
 * Distinct metadata key from `PERMISSION_METADATA_KEY`, read the same way
 * (handler-then-class, via the same `Reflect.getMetadata` mechanism —
 * see `PERMISSION_METADATA_KEY`'s doc for why that mechanism is safe under
 * decorator composition). A route is public if and only if this key is
 * present and `true` on its handler or its controller class — there is no
 * other path to bypassing the guard.
 */
export const PUBLIC_METADATA_KEY = 'gadong:public-route'

/**
 * `@Public()` on a controller method (or a whole controller class) marks a
 * route as reachable with no authenticated principal and no permission
 * check at all — `PermissionGuard` returns `true` immediately, before it
 * even looks at `request.userId`, let alone calls `AuthzClient`.
 *
 * Task 16e: health endpoints (Docker's healthcheck, a load balancer, an
 * uptime monitor — none of which carry a bearer token) were being denied by
 * their own service's globally-mounted `PermissionGuard`, because the guard
 * correctly has no code path from "unannotated" to "allowed". The fix is
 * NOT to weaken that default — it is this decorator: an explicit,
 * affirmative marker that must be typed onto a specific route for that one
 * route to bypass the guard. Forgetting to mark a route still denies it
 * (the property `guard.test.ts`'s "denies a route with no @RequirePermission
 * AND no @Public" test protects); the only way to end up unguarded is to
 * type `@Public()`, which is a reviewable, grep-able, one-line diff — see
 * `public-routes.audit.test.ts` for the cross-service reconciliation gate
 * against `web/ui-coverage.json` that keeps every use of this decorator a
 * deliberate, documented decision rather than a silent accumulation.
 *
 * Do not reach for this for anything other than the small, deliberate set
 * of genuinely-unauthenticated routes (health checks, and the other
 * documented cases — `svc-authz`'s `/decide`, `svc-i18n`'s bundle/glossary
 * routes, `svc-crypto`'s service-to-service routes — each of which has its
 * own carried-forward justification and does not need this decorator
 * because those services never mount `PermissionGuard` as `APP_GUARD` in
 * the first place). A route reached by an authenticated end user must
 * declare `@RequirePermission`, not this.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_METADATA_KEY, true)

/**
 * The minimum a request object must carry for the guard to ask svc-authz.
 * `userId` is optional because "no authenticated principal" is a real,
 * expected shape this guard must handle locally, not assume away
 * (fix round 1, IMPORTANT 4).
 */
export interface AuthenticatedRequest {
  userId?: string
}

/**
 * Distinct from `permissionDenied()`: an unannotated route was never
 * assigned a real catalog permission, so its denial must not put a
 * fabricated placeholder string into `details[].permission` — that string
 * would otherwise land in authz-denial audit records looking like a real
 * (but bogus) permission (fix round 1, MINOR).
 */
function noPermissionDeclaredError(): GadongError {
  return new GadongError('AUZ-403', 'authz.error.denied', 403, [{ reason: 'no_permission_declared' }])
}

/**
 * Reads the permission `@RequirePermission` attached to the handler,
 * falling back to the controller class (matching
 * `Reflector#getAllAndOverride`'s handler-then-class precedence), asks
 * `AuthzClient` for a decision, and throws `permissionDenied()` (AUZ-403)
 * unless the decision is an explicit grant for an authenticated caller.
 *
 * Deny-by-default is structural here, not conventional: a handler with no
 * `@RequirePermission` metadata at all — on itself or its class — throws
 * `noPermissionDeclaredError()` before `AuthzClient` is even consulted —
 * there is no code path from "unannotated" to "allowed" (carried-forward
 * binding note; this is the single most important test in this task).
 * Deny-by-default also extends to identity: a request with no authenticated
 * principal is denied locally, before any call to svc-authz, rather than
 * asking svc-authz to decide for `userId: undefined` and trusting whatever
 * it answers (fix round 1, IMPORTANT 4).
 *
 * The ONE exception, and it is checked first, before anything else in this
 * method: `@Public()` (see its own doc above). It is deliberately a
 * SEPARATE metadata key from `@RequirePermission`, not a magic permission
 * value or an optional flag on the same decorator — a route is either
 * unannotated (denied) or carries one of exactly two explicit markers
 * (`@RequirePermission`, checked and enforced; or `@Public`, checked and
 * bypassed). There is still no third, implicit path to "allowed".
 *
 * Intended registration in each service's root module (`AuthzClient` must
 * also be a registered provider):
 *
 *   { provide: APP_GUARD, useClass: PermissionGuard }
 *
 * `@Injectable()` is required for that `useClass` registration to resolve
 * through Nest's DI container — without it every service would have to
 * hand-roll a `useFactory` instead (fix round 1, IMPORTANT 3).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly authzClient: AuthzClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      (Reflect.getMetadata(PUBLIC_METADATA_KEY, context.getHandler()) as boolean | undefined) ??
      (Reflect.getMetadata(PUBLIC_METADATA_KEY, context.getClass()) as boolean | undefined)

    if (isPublic === true) {
      return true
    }

    const permission =
      (Reflect.getMetadata(PERMISSION_METADATA_KEY, context.getHandler()) as string | undefined) ??
      (Reflect.getMetadata(PERMISSION_METADATA_KEY, context.getClass()) as string | undefined)

    if (!permission) {
      throw noPermissionDeclaredError()
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (!request.userId) {
      throw permissionDenied(permission)
    }

    const decision = await this.authzClient.decide(request.userId, permission)

    if (!decision.allowed) {
      throw permissionDenied(permission)
    }

    return true
  }
}
