import { Body, Controller, HttpException, Inject, Param, Post, Req } from '@nestjs/common'
import { GadongError, RequirePermission, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DB_POOL } from './health.controller'
import type { OtRequestInput, OtRequestResult } from './ot.service'
import { OtService } from './ot.service'
import type { OtRequestRow } from './ot.repository'

interface OtDecisionBody {
  decision: 'approve' | 'reject'
  reason?: string
}

/** `POST /ot-requests` -> `ot.request`; `POST /ot-requests/:id/decision` -> `ot.approve` (roadmap permission catalog). */
@Controller()
export class OtController {
  constructor(
    private readonly otService: OtService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Post('ot-requests')
  @RequirePermission('ot.request')
  async request(@Req() req: AuthenticatedRequest, @Body() body: Omit<OtRequestInput, 'employeeId'> & { employeeId?: string }): Promise<OtRequestResult> {
    // A manager may request OT on behalf of a named employee (body.employeeId);
    // an employee requesting their own OT relies on the authenticated caller's
    // own id — never trusting an unauthenticated employeeId with no fallback.
    const employeeId = body.employeeId ?? req.userId
    if (!employeeId) {
      throw new HttpException({ code: 'SCH-401', message_i18n_key: 'scheduler.error.unauthenticated', details: [] }, 401)
    }
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.otService.request(tx, { ...body, employeeId })),
    )
  }

  @Post('ot-requests/:id/decision')
  @RequirePermission('ot.approve')
  async decide(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: OtDecisionBody): Promise<OtRequestRow> {
    if (!req.userId) {
      throw new HttpException({ code: 'SCH-401', message_i18n_key: 'scheduler.error.unauthenticated', details: [] }, 401)
    }
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.otService.decide(tx, id, body.decision, req.userId as string, body.reason ?? null)),
    )
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
