import 'reflect-metadata'
import { APP_GUARD } from '@nestjs/core'
import { PERMISSION_METADATA_KEY } from '@gadong/kernel'
import { AppModule } from './app.module'
import { BundlesController } from './bundles.controller'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * `/bundles/:locale`, `/glossary` and `/health` are public by design (see
 * the comment on `BundlesController` and `app.module.ts`) — the login
 * screen needs strings before anyone holds a token. These tests pin that
 * down structurally, the same way `svc-crypto`'s "AppModule does not mount
 * the kernel PermissionGuard" suite does, so a future PR that reflexively
 * adds `{ provide: APP_GUARD, useClass: PermissionGuard }` (copying
 * `svc-config`) breaks a test instead of silently locking the login screen
 * out of its own strings.
 */
describe('AppModule does not mount the kernel PermissionGuard — every route here is deliberately public', () => {
  it('registers no APP_GUARD provider', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const hasAppGuard = providers.some((p) => isRecord(p) && p['provide'] === APP_GUARD)
    expect(hasAppGuard).toBe(false)
  })
})

describe('BundlesController — no @RequirePermission anywhere (nothing to gate)', () => {
  it.each(['getBundle', 'getGlossary', 'health'])('has no @RequirePermission metadata on %s()', (method) => {
    const proto = BundlesController.prototype as unknown as Record<string, () => unknown>
    const handler = proto[method]
    if (!handler) throw new Error(`no such handler: ${method}`)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })

  it('has no class-level @RequirePermission either', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, BundlesController)).toBeUndefined()
  })
})
