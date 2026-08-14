import { Body, Controller, Delete, Get, HttpException, Inject, Param, Post, Req, UseGuards } from '@nestjs/common'
import { GadongError, PermissionGuard, RequirePermission, buildHealth, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest, HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import { AuthzService } from './authz.service'
import type { Decision } from './authz.service'
import { AuthzRepository } from './authz.repository'
import type { RoleRow, UserRoleGrantRow } from './authz.repository'

/** DI token for the `authz` schema's connection pool — same `Symbol` token pattern `svc-config`'s `DB_POOL` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')

interface DecideBody {
  userId: string
  permission: string
}

interface GrantRoleBody {
  roleId: string
  orgScopeUnitId?: string | null
  grantedBy: string
}

interface RoleWithPermissions extends RoleRow {
  permissions: string[]
}

function isDecideBody(v: unknown): v is DecideBody {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>)['userId'] === 'string' &&
    typeof (v as Record<string, unknown>)['permission'] === 'string'
  )
}

function roleNotFound(roleId: string): GadongError {
  return new GadongError('AUZ-404', 'authz.error.role_not_found', 404, [{ roleId }])
}

/** The one denial `/decide` itself can ever produce — a fresh object every call, matching `@gadong/kernel`'s `authz/client.ts` `deniedDecision()` note: a shared constant here would let one caller's mutation corrupt every other denied decision. */
function deniedDecision(): Decision {
  return { allowed: false, scopeOrgUnitIds: [] }
}

/**
 * The HTTP boundary for `/decide`, `/roles`, `/users/:id/roles*` and
 * `/health` (Task 8 brief §2). This controller mixes two kinds of route,
 * which is why `AppModule` does NOT mount the kernel's `PermissionGuard`
 * globally (unlike `svc-config`) and does NOT skip it entirely (unlike
 * `svc-crypto`) — see `app.module.ts` and this file's per-method
 * `@UseGuards`:
 *
 *  - `POST /decide` has deliberately NO `@RequirePermission` and NO
 *    `@UseGuards(PermissionGuard)`. It is the handler `PermissionGuard`
 *    itself calls (via `AuthzClient`) for every permission check in every
 *    other service — guarding it would mean asking `/decide` to decide
 *    whether the caller may call `/decide`, which has no non-circular
 *    answer. `decide.wire-contract.test.ts` and this file's own tests
 *    assert directly that neither piece of metadata is present, not just
 *    that behaviour happens to work.
 *  - `GET /roles` and the two grant-admin routes ARE reached by human HR
 *    admins and so ARE guarded, individually, with
 *    `@UseGuards(PermissionGuard)` + `@RequirePermission(...)` — the same
 *    deny-by-default `svc-config`'s routes get via `APP_GUARD`, just
 *    applied per-method here.
 *
 * **Why this service keeps the per-route pattern (reviewed 2026-08-04,
 * guard convergence).** Every other service converged on a global
 * `APP_GUARD` plus `@Public()`, because per-route mounting fails open for
 * routes nobody remembered to decorate. `svc-authz` is the one documented
 * exception, and it is a genuine one: `@Public()` on `/decide` would make
 * the guard return `true` before consulting anything, which WOULD work
 * mechanically — but it would also mean this service's authorisation
 * posture depended on a decorator staying attached to the single most
 * security-critical route in the system, where forgetting it produces
 * infinite recursion (`/decide` asking `/decide`) rather than a clean
 * denial. Leaving `/decide` guardless by construction, and guarding the
 * three admin routes explicitly, keeps the circular route incapable of
 * being guarded rather than merely exempted from guarding.
 *
 * The failure mode that costs — a controller added here later inheriting
 * no guard — is closed by test, not by mounting:
 * `packages/kernel/src/authz/guard-mounting.audit.test.ts` requires every
 * route in this service to carry `@UseGuards(PermissionGuard)` or appear
 * in its named `/decide`-and-`/health` allowlist, so a new unguarded route
 * fails the build.
 *
 * `AuthzClient` (used inside `PermissionGuard`, wired in `app.module.ts`)
 * therefore calls back into this same running service's own `/decide` over
 * HTTP — a self-referential network hop, not recursion, since `/decide`'s
 * own handler below never itself calls `AuthzClient.decide`.
 */
@Controller()
export class AuthzController {
  constructor(
    private readonly authzService: AuthzService,
    private readonly authzRepo: AuthzRepository,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Fail-closed at every layer, deliberately redundant with
   * `AuthzService.decide`'s own internal catch (belt-and-suspenders): a
   * malformed body, or literally any unexpected throw anywhere below this
   * line, resolves to the same denial `{allowed:false, scopeOrgUnitIds:[]}`
   * rather than ever propagating an exception out of this handler. A
   * thrown error here would surface as a non-200 HTTP response that
   * `AuthzClient`'s `isDecision` check would then reject anyway (falling
   * back to its own fail-closed denial) — but this handler does not rely
   * on that fallback; it is fail-closed on its own terms (Task 8 brief,
   * carried-forward binding: "any error in /decide resolves to denied,
   * never to allowed").
   */
  @Post('decide')
  async decide(@Body() body: unknown): Promise<Decision> {
    try {
      if (!isDecideBody(body)) return deniedDecision()
      return await this.authzService.decide(body.userId, body.permission)
    } catch {
      return deniedDecision()
    }
  }

  @Get('roles')
  @UseGuards(PermissionGuard)
  @RequirePermission('authz.role.read')
  async listRoles(): Promise<{ roles: RoleWithPermissions[] }> {
    return this.runFailClosed(async () => {
      const roles = await this.authzRepo.listRoles()
      const withPermissions = await Promise.all(
        roles.map(async (role) => ({ ...role, permissions: await this.authzRepo.listPermissionCodesForRole(role.id) })),
      )
      return { roles: withPermissions }
    })
  }

  @Post('users/:id/roles')
  @UseGuards(PermissionGuard)
  @RequirePermission('authz.role.grant')
  async grantRole(@Req() req: AuthenticatedRequest, @Param('id') userId: string, @Body() body: GrantRoleBody): Promise<UserRoleGrantRow> {
    return this.runFailClosed(async () => {
      const role = await this.authzRepo.findRoleById(body.roleId)
      if (!role) throw roleNotFound(body.roleId)
      return withTransaction(this.pool, (tx) =>
        this.authzService.grantRole(
          tx,
          { userId, roleId: body.roleId, orgScopeUnitId: body.orgScopeUnitId ?? null, grantedBy: body.grantedBy },
          actorRole(req),
        ),
      )
    })
  }

  @Delete('users/:id/roles/:roleId')
  @UseGuards(PermissionGuard)
  @RequirePermission('authz.role.grant')
  async revokeRole(@Req() req: AuthenticatedRequest, @Param('id') userId: string, @Param('roleId') roleId: string): Promise<{ deleted: number }> {
    return this.runFailClosed(async () => {
      const deleted = await withTransaction(this.pool, (tx) => this.authzService.revokeRole(tx, userId, roleId, actorId(req), actorRole(req)))
      return { deleted }
    })
  }

  @Get('health')
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    return buildHealth('svc-authz', { db })
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
  }

  /** The same translation every other controller in this codebase performs — see `crypto.controller.ts`/`rules.controller.ts`. Not used by `decide()`, which is fail-closed on its own terms and never throws an `HttpException`. */
  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}

/** Same fallback every other controller's audit wiring uses: an imprecise actor beats a 500 on every audited write. */
function actorId(req: AuthenticatedRequest): string {
  return req.userId ?? 'unknown'
}
function actorRole(req: AuthenticatedRequest): string {
  return req.actorRole ?? 'unknown'
}
