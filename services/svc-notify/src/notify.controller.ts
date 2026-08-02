import { Controller, Get, HttpException, Inject, Param, Query, Post, Req } from '@nestjs/common'
import { GadongError, RequirePermission, buildHealth, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest, HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import { NotifyService, NotificationNotFound } from './notify.service'
import type { EmailTransport } from './notify.service'
import type { NotificationRow } from './notify.repository'

/** DI token for the `notify` schema's connection pool — the same `Symbol` token pattern `svc-config`'s `DB_POOL` established. */
export const DB_POOL = Symbol('DB_POOL')
/** DI token for the injected SMTP transport (real `nodemailer` client in production, a fake in every test — Task 11 brief constraints). */
export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT')

function notFound(id: string): GadongError {
  return new GadongError('NTF-404', 'notify.error.notification_not_found', 404, [{ id }])
}

/**
 * The HTTP boundary for `/notifications*` and `/health` (Task 11 brief).
 * Every route but `/health` declares exactly one permission via the
 * kernel's `@RequirePermission` — deny-by-default is structural in
 * `PermissionGuard`, not a convention this controller could opt out of by
 * omission (matching `services/svc-config`'s `RulesController`).
 *
 * Both notification routes are self-scoped by construction, not by
 * trusting `PermissionGuard`'s scope decision: `req.userId` (the
 * AUTHENTICATED caller, set upstream of this controller) is the only
 * source of the recipient id ever passed to `NotifyService` — there is no
 * code path where a caller can read or acknowledge another user's
 * notifications by supplying a different id in the request.
 */
@Controller()
export class NotifyController {
  constructor(
    private readonly notifyService: NotifyService,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(EMAIL_TRANSPORT) private readonly emailTransport: EmailTransport,
  ) {}

  @Get('notifications')
  @RequirePermission('notify.notification.read')
  async list(@Req() req: AuthenticatedRequest, @Query('unread') unread?: string): Promise<{ notifications: NotificationRow[] }> {
    const recipientUserId = this.requireUserId(req)
    const rows = await this.notifyService.listNotifications(recipientUserId, unread === 'true')
    return { notifications: rows }
  }

  @Post('notifications/:id/read')
  @RequirePermission('notify.notification.update')
  async markRead(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<NotificationRow> {
    const recipientUserId = this.requireUserId(req)
    return this.runFailClosed(async () => {
      try {
        return await withTransaction(this.pool, (tx) => this.notifyService.markRead(tx, id, recipientUserId))
      } catch (err) {
        if (err instanceof NotificationNotFound) throw notFound(id)
        throw err
      }
    })
  }

  @Get('health')
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    const smtp = await this.checkSmtp()
    return buildHealth('svc-notify', { db, smtp })
  }

  /**
   * `PermissionGuard` already denies any request with no authenticated
   * principal (`authz/guard.ts`: "an authenticated caller") before a
   * handler runs at all, so `req.userId` being absent here would mean the
   * guard was bypassed — this is a belt, not the primary defence, and
   * throwing rather than silently falling back to some default id is the
   * fail-closed choice (never resolve "no caller" to "the caller is
   * nobody-in-particular, show them everything").
   */
  private requireUserId(req: AuthenticatedRequest): string {
    if (!req.userId) throw new HttpException({ code: 'NTF-401', message_i18n_key: 'notify.error.unauthenticated', details: [] }, 401)
    return req.userId
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
  }

  private async checkSmtp(): Promise<'up' | 'down'> {
    try {
      return (await this.emailTransport.verify()) ? 'up' : 'down'
    } catch {
      return 'down'
    }
  }

  /** The same translation `rules.controller.ts` performs: a thrown `GadongError` becomes the `{code, message_i18n_key, details}` envelope at its declared HTTP status; anything else is a genuine bug and is left to propagate. */
  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}
