import { Body, Controller, Get, HttpException, Inject, Param, Post } from '@nestjs/common'
import { GadongError, Public, RequirePermission, buildHealth, outboxDepth, withTransaction } from '@gadong/kernel'
import type { HealthPayload, Locale } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DocumentsService } from './documents.service'
import type { RenderRequest } from './documents.service'
import type { MergeFields } from './merge-fields'

/** DI token for the `docs` schema's connection pool — same `Symbol` token pattern `svc-config`'s `DB_POOL` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')

export interface RenderRequestBody {
  kind: string
  lang: Locale
  entityType: string
  entityId: string
  mergeFields: MergeFields
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
  async render(@Body() body: RenderRequestBody): Promise<RenderResponseBody> {
    return this.runFailClosed(async () => {
      const input: RenderRequest = {
        kind: body.kind,
        lang: body.lang,
        entityType: body.entityType,
        entityId: body.entityId,
        mergeFields: body.mergeFields,
      }
      const prepared = await this.documentsService.prepare(input)
      return withTransaction(this.pool, (tx) => this.documentsService.commit(tx, prepared))
    })
  }

  @Get('documents/:id')
  @RequirePermission('document.read')
  async getById(@Param('id') id: string): Promise<DocumentResponseBody> {
    return this.runFailClosed(async () => {
      const { meta, pdfBytes } = await this.documentsService.getDocument(id)
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
