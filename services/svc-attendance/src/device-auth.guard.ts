import { Inject, Injectable } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { canonicalJson } from '@gadong/kernel'
import { DeviceService } from './device.service'
import { DB_POOL } from './attendance.controller'
import type { Pool } from 'pg'

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
