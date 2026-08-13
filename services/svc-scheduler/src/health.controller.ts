import { Controller, Get, Inject } from '@nestjs/common'
import { Public, buildHealth, outboxDepth } from '@gadong/kernel'
import type { HealthPayload, Queryable } from '@gadong/kernel'

/** DI token for the `scheduler` schema's connection pool — matches `services/svc-config`'s `DB_POOL` pattern. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')

/**
 * The HTTP boundary for `GET /health`.
 *
 * **Fixed 2026-08-04 (integration reconciliation), a live defect.** This
 * comment used to read "no `PermissionGuard` mounted in `AppModule`", and
 * `packages/kernel/src/authz/public-routes.audit.test.ts` encoded the same
 * belief ("M2 did not mount a global guard, so its health route needs no
 * bypass"). Both were stale: M2's Phase 3 build DID add
 * `{ provide: APP_GUARD, useClass: PermissionGuard }` to `app.module.ts`
 * when it added the rostering controllers. With a global guard mounted and
 * neither `@Public()` nor `@RequirePermission` on this route,
 * `PermissionGuard` reaches its "no permission declared" branch and throws
 * AUZ-403 — so `GET /health` returned 403 to compose's healthcheck, the
 * deploy script and monitoring, on every request.
 *
 * Nothing caught it: the audit test only compares `@Public()` MARKERS
 * against its expected list (a route that is neither public nor guarded is
 * invisible to it), and `health.controller.test.ts` calls `health()`
 * directly, which never runs a guard. The `every route in a globally
 * guarded service declares @RequirePermission or @Public()` assertion added
 * to `packages/kernel/src/authz/guard-mounting.audit.test.ts` is what makes
 * this class of defect visible from now on.
 */
@Controller()
export class HealthController {
  constructor(@Inject(DB_POOL) private readonly pool: Queryable) {}

  @Get('health')
  @Public()
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    // "A stuck outbox must be observable" (event-bus task) — `roster.published`,
    // `roster.entry.published` and `ot.approved` rows this service writes
    // must actually reach the bus; if the relay stalls, downstream
    // consumers silently stop hearing about published rosters/approved OT.
    // See `services/svc-payroll/src/payroll.controller.ts`'s identical
    // wiring/reasoning.
    let outbox: { pending: number; oldestAgeSeconds: number | null } | undefined
    let outboxQuery: 'up' | 'down' = 'up'
    try {
      outbox = await outboxDepth(this.pool, 'scheduler')
    } catch {
      outboxQuery = 'down'
    }
    return buildHealth('svc-scheduler', { db, ...(outboxQuery === 'down' ? { outboxQuery } : {}) }, process.env, outbox)
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
  }
}
