import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common'
import { RequirePermission, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DB_POOL } from './attendance.controller'
import { DeviceService } from './device.service'
import type { DeviceKind, DeviceRow } from './device.repository'
import { runFailClosed } from './http-fail-closed'

interface Req extends AuthenticatedRequest {
  actorRole?: string
}
function actorId(req: Req): string {
  return req.userId ?? 'unknown'
}
function actorRole(req: Req): string {
  return req.actorRole ?? 'unknown'
}

interface RegisterDeviceBody {
  kind: DeviceKind
  siteCode: string
  secret: string
}

/** `/devices*` — module doc §3 row 10: registration with second-person approval (`DeviceService.approve`). */
@Controller('devices')
export class DeviceController {
  constructor(
    private readonly devices: DeviceService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Get()
  @RequirePermission('attendance.device.manage')
  async list(): Promise<{ devices: DeviceRow[] }> {
    return runFailClosed(async () => ({ devices: await this.devices.list(this.pool) }))
  }

  @Post()
  @RequirePermission('attendance.device.manage')
  async register(@Body() body: RegisterDeviceBody, @Req() req: Req): Promise<DeviceRow> {
    return runFailClosed(() => withTransaction(this.pool, (tx) => this.devices.register(tx, body, actorId(req), actorRole(req))))
  }

  @Post(':id/approve')
  @RequirePermission('attendance.device.manage')
  async approve(@Param('id') id: string, @Req() req: Req): Promise<DeviceRow> {
    return runFailClosed(() => withTransaction(this.pool, (tx) => this.devices.approve(tx, id, actorId(req), actorRole(req))))
  }
}
