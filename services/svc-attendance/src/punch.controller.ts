import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common'
import { RequirePermission, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DB_POOL } from './attendance.controller'
import { PunchService } from './punch.service'
import { PunchRepository } from './punch.repository'
import type { InsertPunchResult, NewPunchRow, PunchDirection, PunchRow } from './punch.repository'
import type { AlternativeKind } from './alternative-credential.repository'
import { DeviceAuthenticated } from './device-auth.guard'
import type { DeviceAuthenticatedRequest } from './device-auth.guard'
import { runFailClosed } from './http-fail-closed'

interface Req extends AuthenticatedRequest {
  actorRole?: string
}

function toResponse(result: InsertPunchResult): { punch: PunchRow; duplicate: boolean } {
  return { punch: result.row, duplicate: result.duplicate }
}

interface FacePunchBody {
  idemKey: string
  direction: PunchDirection
  siteCode: string
  punchedAt: string
  frame: string // base64
}
interface VerifyPunchBody {
  idemKey: string
  direction: PunchDirection
  siteCode: string
  punchedAt: string
  deviceId: string
  sessionToken: string
  frame: string // base64
}
interface CodePunchBody {
  idemKey: string
  direction: PunchDirection
  siteCode: string
  punchedAt: string
  deviceId: string
  kind: AlternativeKind
  code: string
  employeeId?: string
}
interface BatchPunchItem {
  idemKey: string
  employeeId: string
  punchedAt: string
  direction: PunchDirection
  method: NewPunchRow['method']
  matchScore: number | null
  livenessPassed: boolean | null
  siteCode: string
}
interface BatchPunchBody {
  punches: BatchPunchItem[]
}

/**
 * `/punches*` and `/my/punches` — M4-2/M4-3/M4-4/M4-5/M4-6. Kiosk-only
 * routes (`/face`, `/batch`) are protected by `DeviceAuthGuard` (per-device
 * HMAC, module doc §3) instead of `OidcMiddleware`; `/verify` (mobile 1:1)
 * and `/my/punches` are ordinary OIDC self-service routes; `/code` accepts
 * either (a PIN typed on a kiosk keypad, or a QR/badge scan — module doc:
 * "device/self").
 */
@Controller()
export class PunchController {
  constructor(
    private readonly punches: PunchService,
    private readonly punchRepo: PunchRepository,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  // Guard ORDER still matters, but it is no longer expressed here.
  // `DeviceAuthGuard` must run BEFORE `PermissionGuard` — it is what
  // populates `request.userId` (as `device:<id>`) for a kiosk call, which
  // `PermissionGuard` then reads. That used to force
  // `@UseGuards(DeviceAuthGuard, PermissionGuard)` onto these two routes,
  // which in turn is why this service could not mount a global `APP_GUARD`
  // (Nest runs global guards BEFORE route guards, so a global
  // `PermissionGuard` would have denied every kiosk request before
  // `DeviceAuthGuard` ever ran). The ordering now lives in the `APP_GUARD`
  // registration order in `app.module.ts`, which Nest honours, and
  // `@DeviceAuthenticated()` marks which routes the first of those two
  // guards actually acts on. Same order, same behaviour, no per-route
  // guard mounting. See `device-auth.guard.ts`'s header.
  @Post('punches/face')
  @DeviceAuthenticated()
  @RequirePermission('attendance.punch.device')
  async face(@Body() body: FacePunchBody, @Req() req: DeviceAuthenticatedRequest) {
    const deviceId = req.deviceId
    if (!deviceId) throw new Error('PunchController.face: DeviceAuthGuard did not populate request.deviceId')
    return runFailClosed(async () => {
      const result = await withTransaction(this.pool, (tx) =>
        this.punches.recordFacePunch(tx, {
          deviceId, idemKey: body.idemKey, direction: body.direction, siteCode: body.siteCode,
          punchedAt: body.punchedAt, frame: Buffer.from(body.frame, 'base64'),
        }),
      )
      return toResponse(result)
    })
  }

  @Post('punches/verify')
  @RequirePermission('attendance.punch.verify')
  async verify(@Body() body: VerifyPunchBody, @Req() req: Req) {
    const employeeId = req.userId ?? 'unknown'
    return runFailClosed(async () => {
      const result = await withTransaction(this.pool, (tx) =>
        this.punches.recordVerifyPunch(tx, {
          deviceId: body.deviceId, idemKey: body.idemKey, direction: body.direction, siteCode: body.siteCode,
          punchedAt: body.punchedAt, employeeId, sessionToken: body.sessionToken, frame: Buffer.from(body.frame, 'base64'),
        }),
      )
      return toResponse(result)
    })
  }

  @Post('punches/code')
  @RequirePermission('attendance.punch.code')
  async code(@Body() body: CodePunchBody, @Req() req: Req) {
    const employeeId = body.employeeId ?? (body.kind === 'pin' ? req.userId : undefined)
    return runFailClosed(async () => {
      const result = await withTransaction(this.pool, (tx) =>
        this.punches.recordCodePunch(tx, {
          deviceId: body.deviceId, idemKey: body.idemKey, direction: body.direction, siteCode: body.siteCode,
          punchedAt: body.punchedAt, kind: body.kind, code: body.code, employeeId,
        }),
      )
      return toResponse(result)
    })
  }

  @Post('punches/batch')
  @DeviceAuthenticated()
  @RequirePermission('attendance.punch.device')
  async batch(@Body() body: BatchPunchBody, @Req() req: DeviceAuthenticatedRequest) {
    const deviceId = req.deviceId
    if (!deviceId) throw new Error('PunchController.batch: DeviceAuthGuard did not populate request.deviceId')
    return runFailClosed(async () => {
      const rows: Array<Omit<NewPunchRow, 'id'>> = body.punches.map((p) => ({ ...p, deviceId, geo: null }))
      const results = await withTransaction(this.pool, (tx) => this.punches.replayBatch(tx, rows))
      return { punches: results.map(toResponse) }
    })
  }

  @Get('my/punches')
  @RequirePermission('attendance.punch.read')
  async myPunches(@Query('from') from: string, @Query('to') to: string, @Req() req: Req): Promise<{ punches: PunchRow[] }> {
    const employeeId = req.userId ?? 'unknown'
    return runFailClosed(async () => {
      // Own history only — never returns a score to the employee themselves (module doc row 9): strip matchScore before returning.
      const rows = await this.punchRepo.listForEmployee(this.pool, employeeId, from, to)
      return { punches: rows.map((r) => ({ ...r, matchScore: null })) }
    })
  }
}
