import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { createPool } from '@gadong/kernel'
import { DB_POOL, HealthController } from './health.controller'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-scheduler: ${name} is required`)
  return value
}

/**
 * Task 14 scope is schema + migrations + `/health` only — no rostering,
 * conflict-detection, holiday-generation, or OT-approval logic (Phase 3
 * owns those, per the task brief). Once Phase 3 adds real routes reached by
 * end users, it should mount the kernel's `PermissionGuard` as `APP_GUARD`
 * and `OidcMiddleware`, matching `services/svc-config`'s `AppModule` —
 * there is nothing to guard yet, so that wiring is deliberately not added
 * here rather than added inert.
 */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `scheduler` so every unqualified
      // table name resolves in this service's own schema and nowhere else
      // (global-constraints: "every service owns one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'scheduler'),
    },
  ],
})
export class AppModule {}
