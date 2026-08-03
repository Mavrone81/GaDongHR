import { Body, Controller, Get, HttpException, Inject, Param, Patch, Post } from '@nestjs/common'
import { GadongError, RequirePermission, withTransaction } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DB_POOL } from './health.controller'
import { ShiftsService } from './shifts.service'
import type { ShiftPatch, ShiftRow, NewShiftRow } from './shifts.repository'

/**
 * `POST/PATCH /shifts` need `roster.write` (creating/editing shift
 * definitions is part of "create or edit a roster" in the permission
 * catalog — there is no separate `shift.*` code); `GET /shifts` needs only
 * `roster.read`. Matches `docs/superpowers/plans/00-PROGRAM-ROADMAP.md`'s
 * permission catalog verbatim (`services/svc-authz/src/seed/roles.ts`'s
 * `PERMISSION_CATALOG`) — NOT the M2-SCHEDULER draft's `schedule.*` names,
 * which predate that catalog and were never wired into `svc-authz`'s seed
 * (see this task's report, "deviations").
 */
@Controller()
export class ShiftsController {
  constructor(
    private readonly shiftsService: ShiftsService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Post('shifts')
  @RequirePermission('roster.write')
  async create(@Body() body: NewShiftRow): Promise<ShiftRow> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.shiftsService.create(tx, body)))
  }

  @Get('shifts')
  @RequirePermission('roster.read')
  async list(): Promise<{ shifts: ShiftRow[] }> {
    const shifts = await this.runFailClosed(() => this.shiftsService.list())
    return { shifts }
  }

  @Get('shifts/:id')
  @RequirePermission('roster.read')
  async get(@Param('id') id: string): Promise<ShiftRow> {
    return this.runFailClosed(() => this.shiftsService.get(id))
  }

  @Patch('shifts/:id')
  @RequirePermission('roster.write')
  async patch(@Param('id') id: string, @Body() body: ShiftPatch): Promise<ShiftRow> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.shiftsService.patch(tx, id, body)))
  }

  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}
