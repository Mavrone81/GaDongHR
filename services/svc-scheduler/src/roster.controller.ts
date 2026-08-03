import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Req } from '@nestjs/common'
import { GadongError, RequirePermission, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DB_POOL } from './health.controller'
import type { AssignInput, CopyPatternInput, CopyPatternResult, PublishInput, PublishResult, AssignResult } from './roster.service'
import { RosterService } from './roster.service'
import type { RosterEntryRow } from './roster.repository'

interface OverrideBody {
  reason: string
}

/**
 * `/rosters*` (M2-2/M2-4) and `/my/schedule` (self-scoped). Permission
 * mapping follows the roadmap's catalog (`roster.read`/`roster.write`/
 * `roster.publish`), not the M2-SCHEDULER draft's `schedule.*` names — see
 * `shifts.controller.ts`'s header for the same note.
 */
@Controller()
export class RosterController {
  constructor(
    private readonly rosterService: RosterService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Get('rosters')
  @RequirePermission('roster.read')
  async grid(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('employeeIds') employeeIds?: string,
  ): Promise<{ entries: RosterEntryRow[] }> {
    const ids = employeeIds ? employeeIds.split(',') : undefined
    const entries = await this.runFailClosed(() => this.rosterService.listGrid(from, to, ids))
    return { entries }
  }

  @Post('rosters/entries')
  @RequirePermission('roster.write')
  async assign(@Body() body: AssignInput): Promise<AssignResult> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.rosterService.assign(tx, body)))
  }

  @Post('rosters/entries/:id/override')
  @RequirePermission('roster.write')
  async override(@Param('id') id: string, @Body() body: OverrideBody): Promise<RosterEntryRow> {
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.rosterService.overrideExisting(tx, id, body.reason)),
    )
  }

  @Post('rosters/copy')
  @RequirePermission('roster.write')
  async copy(@Body() body: CopyPatternInput): Promise<CopyPatternResult> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.rosterService.copyPattern(tx, body)))
  }

  @Post('rosters/publish')
  @RequirePermission('roster.publish')
  async publish(@Body() body: PublishInput): Promise<PublishResult> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.rosterService.publish(tx, body)))
  }

  /** Self-scoped by construction: the employee id is always the AUTHENTICATED caller's own id, never a request param — same pattern as `services/svc-notify`'s `NotifyController`. */
  @Get('my/schedule')
  @RequirePermission('roster.read')
  async mySchedule(
    @Req() req: AuthenticatedRequest,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<{ entries: RosterEntryRow[] }> {
    if (!req.userId) throw new HttpException({ code: 'SCH-401', message_i18n_key: 'scheduler.error.unauthenticated', details: [] }, 401)
    const entries = await this.runFailClosed(() => this.rosterService.listGrid(from, to, [req.userId as string]))
    return { entries }
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
