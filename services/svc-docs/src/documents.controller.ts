import { Body, Controller, Get, HttpException, Inject, Param, Post, Req } from '@nestjs/common'
import { GadongError, Public, RequirePermission, buildHealth, outboxDepth, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest, HealthPayload, Locale } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DOCUMENT_READ_PURPOSE, DocumentsService } from './documents.service'
import type { RenderRequest } from './documents.service'
import type { MergeFields } from './merge-fields'

/** DI token for the `docs` schema's connection pool — same `Symbol` token pattern `svc-config`'s `DB_POOL` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')

export interface RenderRequestBody {
  kind: string
  lang: Locale
  entityType: string
  entityId: string
  /** Template-owned rendering. Mutually exclusive with `html` — see `DocumentsService.resolveHtml`'s doc. */
  mergeFields?: MergeFields
  /** Caller-owned rendering: the caller has already composed complete HTML and only needs this service's font-check/PDF/storage/encryption pipeline. Mutually exclusive with `mergeFields`. */
  html?: string
}

export interface RenderResponseBody {
  id: string
  kind: string
  entityType: string
  entityId: string
  lang: string
  sha256: string
}

export interface DocumentResponseBody {
  id: string
  kind: string
  entityType: string
  entityId: string
  lang: string
  sha256: string
  createdAt: string
  /** The PDF bytes, base64-encoded. Every route on this controller but `/health` requires a permission (deny-by-default is structural in kernel `PermissionGuard`), so this is not an unauthenticated download endpoint. */
  contentBase64: string
}

/**
 * The HTTP boundary for `/render`, `/documents/:id` and `/health` (task
 * brief §"API"). Every route but `/health` declares exactly one permission
 * via the kernel's `@RequirePermission` — deny-by-default is structural in
 * `PermissionGuard`, not a convention this controller could opt out of by
 * omission (`app.module.ts` mounts it as `APP_GUARD`, matching
 * `services/svc-config` — `svc-docs` is reached by HR admins/managers
 * requesting payslips and contracts, not service-to-service only).
 *
 * `POST /render` deliberately does its slow external I/O (template
 * resolution, font coverage check, PDF render, MinIO put, envelope
 * encryption — `DocumentsService.prepare()`) BEFORE opening the database
 * transaction, and only holds a connection for the fast `INSERT` +
 * `document.rendered` outbox write (`DocumentsService.commit()`, via
 * kernel `withTransaction`) — unlike `svc-config`'s writes, which are pure
 * DB operations for their whole duration, this one has real network calls
 * in it that must not hold a pool connection hostage while they run.
 */
@Controller()
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Post('render')
  @RequirePermission('document.generate')
  async render(@Req() req: AuthenticatedRequest, @Body() body: RenderRequestBody): Promise<RenderResponseBody> {
    return this.runFailClosed(async () => {
      const input: RenderRequest = {
        kind: body.kind,
        lang: body.lang,
        entityType: body.entityType,
        entityId: body.entityId,
        mergeFields: body.mergeFields,
        html: body.html,
      }
      const prepared = await this.documentsService.prepare(input)
      return withTransaction(this.pool, (tx) => this.documentsService.commit(tx, prepared, actorId(req), actorRole(req)))
    })
  }

  @Get('documents/:id')
  @RequirePermission('document.read')
  async getById(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<DocumentResponseBody> {
    return this.runFailClosed(async () => {
      const purpose = DOCUMENT_READ_PURPOSE
      const { meta, pdfBytes } = await this.documentsService.getDocument(id, this.requireUserId(req), this.requireScope(req), purpose)
      // The read/download itself never holds a transaction (MinIO GET +
      // decrypt — see `DocumentsService.getDocument`'s doc); the audit
      // entry is its own fast, separate write, same split
      // `PayrollController.getProfile` uses.
      await withTransaction(this.pool, (tx) => this.documentsService.commitReadAudit(tx, meta, purpose, actorId(req), actorRole(req)))
      return {
        id: meta.id,
        kind: meta.kind,
        entityType: meta.entityType,
        entityId: meta.entityId,
        lang: meta.lang,
        sha256: meta.sha256,
        createdAt: meta.createdAt,
        contentBase64: pdfBytes.toString('base64'),
      }
    })
  }

  @Get('health')
  @Public()
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    const { storage, fonts } = await this.documentsService.health()
    // "A stuck outbox must be observable" (event-bus task) — a
    // `document.rendered` row the relay has fallen behind on must surface
    // here, the one place an operator already looks. A failure reading the
    // outbox itself (distinct from `db` above, which only proves the pool
    // can run `SELECT 1`) degrades the response rather than being
    // swallowed into a healthy-looking zero — same fail-closed reasoning as
    // every other dependency check on this endpoint.
    let outbox: { pending: number; oldestAgeSeconds: number | null } | undefined
    let outboxQuery: 'up' | 'down' = 'up'
    try {
      outbox = await outboxDepth(this.pool, 'docs')
    } catch {
      outboxQuery = 'down'
    }
    return buildHealth('svc-docs', { db, storage, fonts, ...(outboxQuery === 'down' ? { outboxQuery } : {}) }, process.env, outbox)
  }

  /** `PermissionGuard` already denied any request with no authenticated principal before this handler runs (`document.read` is not `@Public()`) — this narrows the type, it does not add a new check. */
  private requireUserId(req: AuthenticatedRequest): string {
    if (!req.userId) throw new HttpException({ code: 'DOC-401', message_i18n_key: 'docs.error.unauthenticated', details: [] }, 401)
    return req.userId
  }

  /**
   * `PermissionGuard` sets `request.authzScope` on every ALLOWED decision
   * (see kernel `guard.ts`) — reaching this handler at all means the guard
   * already granted `document.read`, so this is only absent if a future
   * refactor removed that assignment; fails closed rather than silently
   * treating a missing scope as `'*'`.
   */
  private requireScope(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['authzScope']> {
    if (req.authzScope === undefined) {
      throw new HttpException({ code: 'DOC-500', message_i18n_key: 'docs.error.scope_missing', details: [] }, 500)
    }
    return req.authzScope
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
  }

  /** The same translation `svc-config`'s `RulesController`/`svc-crypto`'s `CryptoController` perform: a thrown `GadongError` becomes the `{code, message_i18n_key, details}` envelope at its declared HTTP status; anything else is a genuine bug and is left to propagate. */
  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}

/** Same fallback `svc-onboarding`'s `employee.controller.ts`/`svc-payroll`'s `payroll.controller.ts` use for their own audit entries: an imprecise actor beats a 500 on every audited write or read. */
function actorId(req: AuthenticatedRequest): string {
  return req.userId ?? 'unknown'
}
function actorRole(req: AuthenticatedRequest): string {
  return req.actorRole ?? 'unknown'
}
