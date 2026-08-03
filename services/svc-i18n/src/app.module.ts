import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { GadongErrorFilter } from '@gadong/kernel'
import { BundlesController } from './bundles.controller'
import { BundlesService } from './bundles.service'
import { loadRawBundles } from './bundle-loader'
import type { RawBundles } from './bundles.service'

/** DI token for the parsed-but-not-yet-flattened `{th,en,zh}` bundle JSON, read once at boot by `loadRawBundles` (see `bundle-loader.ts`). */
export const RAW_BUNDLES = Symbol('RAW_BUNDLES')

/**
 * Deliberately no `{ provide: APP_GUARD, useClass: PermissionGuard }` here
 * — see the comment on `BundlesController`. Every route this service
 * exposes (`/bundles/:locale`, `/glossary`, `/health`) is public by design:
 * the login screen has to render its own labels before any principal
 * exists for a permission check to run against. `svc-crypto` documents the
 * same absence for a different reason (service-to-service only, so a
 * guard would only ever see internal callers) and `svc-authz` for a third
 * (it IS the permission decision — mounting its own guard would be
 * circular). Three different justifications, same shape: an unguarded
 * `AppModule` here is a deliberate exception, not an omission.
 *
 * There is also no `DATABASE_URL`/`DB_POOL` provider (unlike `svc-config`)
 * — svc-i18n owns no schema (Task 10 brief) — and no `AuthzClient`, since
 * nothing in this service ever calls `PermissionGuard`/`@RequirePermission`.
 */
@Module({
  controllers: [BundlesController],
  providers: [
    // Task 16e, defect 2: maps a thrown `GadongError` (e.g.
    // `localeNotSupported()` in `bundles.controller.ts`) onto its declared
    // HTTP status/envelope — see kernel `http/gadong-error.filter.ts`.
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    { provide: RAW_BUNDLES, useFactory: (): RawBundles => loadRawBundles() },
    {
      provide: BundlesService,
      useFactory: (raw: RawBundles): BundlesService => new BundlesService(raw),
      inject: [RAW_BUNDLES],
    },
  ],
})
export class AppModule {}
