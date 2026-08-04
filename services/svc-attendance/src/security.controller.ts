import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common'
import { GadongError, PermissionGuard, RequirePermission } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DB_POOL } from './attendance.controller'
import { SecurityEventRepository } from './security-event.repository'
import type { SecurityEventKind, SecurityEventRow } from './security-event.repository'
import { runFailClosed } from './http-fail-closed'

const VALID_KINDS: SecurityEventKind[] = ['liveness_failed', 'multi_face']

function invalidKind(kind: string): GadongError {
  return new GadongError('ATT-091', 'attendance.error.invalid_security_event_kind', 400, [{ kind }])
}

/** `GET /security-events?kind=liveness_failed` — module doc §3 row 11: weekly review queue (PRD metric). */
@Controller('security-events')
@UseGuards(PermissionGuard)
export class SecurityController {
  constructor(
    private readonly securityEvents: SecurityEventRepository,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Get()
  @RequirePermission('attendance.security.read')
  async list(@Query('kind') kind: string): Promise<{ events: SecurityEventRow[] }> {
    return runFailClosed(async () => {
      if (!VALID_KINDS.includes(kind as SecurityEventKind)) throw invalidKind(kind)
      return { events: await this.securityEvents.listByKind(this.pool, kind as SecurityEventKind) }
    })
  }
}
