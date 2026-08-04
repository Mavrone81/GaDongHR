import { Body, Controller, Delete, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common'
import { PermissionGuard, RequirePermission, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DB_POOL } from './attendance.controller'
import { EnrolmentService } from './enrolment.service'
import type { AlternativeKind } from './alternative-credential.repository'
import { TemplateDeletionService } from './template-deletion.service'
import { runFailClosed, runFailClosedSync } from './http-fail-closed'

interface Req extends AuthenticatedRequest {
  actorRole?: string
}

function actorId(req: Req): string {
  return req.userId ?? 'unknown'
}
function actorRole(req: Req): string {
  return req.actorRole ?? 'unknown'
}

interface FramesBody {
  frame: string // base64
}
interface CompleteBody {
  images?: string[] // base64, optional — see EnrolmentService.completeEnrolment
}
interface AlternativeBody {
  employeeId?: string
  kind: AlternativeKind
  code: string
}
/**
 * `/enrolments*` — M4-1/M4-5. Guarded per-controller with
 * `@UseGuards(PermissionGuard)` (rather than a global `APP_GUARD` in
 * `AppModule`) so `AttendanceController`'s pre-existing `GET /health` route
 * (Task 14, unguarded, no `@Public()`) is unaffected — see `app.module.ts`.
 */
@Controller('enrolments')
@UseGuards(PermissionGuard)
export class EnrolmentController {
  constructor(
    private readonly enrolments: EnrolmentService,
    private readonly templateDeletion: TemplateDeletionService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Post('start')
  @RequirePermission('attendance.enrol.self')
  async start(@Req() req: Req): Promise<{ session: string }> {
    return runFailClosed(() => this.enrolments.startEnrolment(actorId(req), this.pool))
  }

  @Post(':session/frames')
  @RequirePermission('attendance.enrol.self')
  @HttpCode(200)
  frames(@Param('session') session: string, @Body() body: FramesBody): { ok: true } {
    return runFailClosedSync(() => {
      this.enrolments.addFrame(session, Buffer.from(body.frame, 'base64'))
      return { ok: true }
    })
  }

  @Post(':session/complete')
  @RequirePermission('attendance.enrol.self')
  async complete(@Param('session') session: string, @Body() body: CompleteBody, @Req() req: Req) {
    return runFailClosed(() =>
      withTransaction(this.pool, (tx) =>
        this.enrolments.completeEnrolment(
          tx,
          { session, images: body.images?.map((b) => Buffer.from(b, 'base64')) },
          actorId(req),
          actorRole(req),
        ),
      ),
    )
  }

  @Post('alternative')
  @RequirePermission('attendance.enrol.alternative')
  async alternative(@Body() body: AlternativeBody, @Req() req: Req): Promise<{ ok: true }> {
    const employeeId = body.employeeId ?? actorId(req)
    return runFailClosed(async () => {
      await withTransaction(this.pool, (tx) =>
        this.enrolments.enrolAlternative(tx, { employeeId, kind: body.kind, code: body.code }, actorId(req), actorRole(req)),
      )
      return { ok: true }
    })
  }

  /** System/DPO-triggered verified deletion — the same `TemplateDeletionService` the `consent.withdrawn`/`employee.terminated` event handlers use, invoked on demand rather than from a broker event. */
  @Delete(':employeeId/template')
  @RequirePermission('attendance.template.delete')
  async deleteTemplate(@Param('employeeId') employeeId: string): Promise<{ ok: true }> {
    return runFailClosed(async () => {
      await withTransaction(this.pool, (tx) => this.templateDeletion.deleteForEmployee(tx, employeeId, 'consent_withdrawn'))
      return { ok: true }
    })
  }
}
