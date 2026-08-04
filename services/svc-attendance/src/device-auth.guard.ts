import { Inject, Injectable, SetMetadata } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { canonicalJson } from '@gadong/kernel'
import { DeviceService } from './device.service'
import { DB_POOL } from './attendance.controller'
import type { Pool } from 'pg'

/**
 * Metadata key marking a route as kiosk-authenticated. Mirrors the kernel's
 * own `'gadong:public-route'` / `'gadong:required-permission'` convention so
 * `DeviceAuthGuard` can read it with the same handler-then-class
 * `Reflect.getMetadata` precedence `PermissionGuard` uses.
 */
export const DEVICE_AUTH_METADATA_KEY = 'gadong:device-authenticated'

/**
 * Marks a route as kiosk-authenticated: `DeviceAuthGuard` enforces the
 * per-device HMAC on it and populates `request.userId`. An UNMARKED route is
 * a no-op for that guard, which is what lets it be mounted globally (see
 * `app.module.ts`) without touching the human-facing routes.
 */
export const DeviceAuthenticated = (): MethodDecorator & ClassDecorator => SetMetadata(DEVICE_AUTH_METADATA_KEY, true)

/**
 * Kiosk authentication (module doc §3: "Kiosk endpoints authenticate with
 * per-device HMAC secret"), separate from `PermissionGuard`/`OidcMiddleware`
 * — a kiosk has no human OIDC session. Reads `x-device-id` and
 * `x-device-signature` headers, verifies `signature ==
 * hex(HMAC-SHA256(deviceSecret, canonicalJson(body)))` via
 * `DeviceService.verifySignature`, and — only on success — sets
 * `request.userId = "device:<id>"` so the SAME `PermissionGuard` +
 * `@RequirePermission` mechanism every other route uses still applies
 * (`attendance.punch.device` must be granted to a device-role principal in
 * `svc-authz`, exactly like a human permission grant — no special-cased
 * bypass).
 *
 * **Opt-in, and mounted globally (changed 2026-08-04, guard convergence).**
 * This guard used to be applied per-route via
 * `@UseGuards(DeviceAuthGuard, PermissionGuard)`, because Nest runs guards
 * within one `@UseGuards(...)` left-to-right and this one MUST run before
 * `PermissionGuard` — it is what populates the `request.userId` that
 * `PermissionGuard` reads. That per-route mounting is exactly the pattern
 * the reconciliation removed service-wide: it meant `svc-attendance` could
 * not mount a global `APP_GUARD`, so a controller added later would have
 * shipped with no permission check at all.
 *
 * The ordering constraint is now expressed where it belongs — in the
 * `APP_GUARD` registration order in `app.module.ts`, which Nest honours —
 * with this guard registered FIRST and made a no-op on any route not
 * carrying `@DeviceAuthenticated()`. Behaviour on the two kiosk routes is
 * byte-for-byte what it was; behaviour everywhere else is unchanged because
 * this guard now returns `true` immediately there, leaving the decision
 * entirely to `PermissionGuard`.
 */
export interface DeviceAuthenticatedRequest {
  userId?: string
  /** Set by this guard on success — the raw device id, without the `device:` `userId` prefix, for handlers that need it directly (e.g. to stamp `punch_event.device_id`). */
  deviceId?: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(
    private readonly deviceService: DeviceService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Not a kiosk route → this guard has no opinion. Returning `true` here
    // is NOT "allow": `PermissionGuard`, registered immediately after this
    // one as the second `APP_GUARD`, still has to allow the request, and it
    // denies by default. Handler-then-class precedence matches
    // `PermissionGuard`'s own metadata reads.
    const isDeviceRoute =
      (Reflect.getMetadata(DEVICE_AUTH_METADATA_KEY, context.getHandler()) as boolean | undefined) ??
      (Reflect.getMetadata(DEVICE_AUTH_METADATA_KEY, context.getClass()) as boolean | undefined)
    if (isDeviceRoute !== true) return true

    const request = context.switchToHttp().getRequest<DeviceAuthenticatedRequest>()
    const deviceId = headerValue(request.headers['x-device-id'])
    const signature = headerValue(request.headers['x-device-signature'])
    if (!deviceId || !signature) return false

    const payload = Buffer.from(canonicalJson(request.body ?? {}), 'utf8')
    // Any failure inside verifySignature (unknown device, not approved,
    // wrong signature) throws ATT-030 — let it propagate as the guard's own
    // rejection rather than swallowing it into a bare `false`, so the HTTP
    // response carries the same GadongError envelope every other denial does.
    await this.deviceService.verifySignature(this.pool, deviceId, payload, signature)
    request.userId = `device:${deviceId}`
    request.deviceId = deviceId
    return true
  }
}
