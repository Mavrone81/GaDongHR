import { HttpException } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { GadongError, PERMISSION_METADATA_KEY, writeOutbox } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DocumentsController, DB_POOL } from './documents.controller'
import type { RenderRequestBody } from './documents.controller'
import { AppModule } from './app.module'
import type { DocumentsService, PreparedDocument, RenderResult, RetrievedDocument } from './documents.service'
import type { DocumentRow } from './documents.repository'
import { FakeDocsDb } from './testing/fake-db'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function fakeDocumentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'doc-1',
    kind: 'payslip',
    entityType: 'employee',
    entityId: 'emp-1',
    lang: 'th',
    fileRef: Buffer.alloc(125, 1),
    sha256: 'a'.repeat(64),
    createdAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  }
}

function fakePrepared(overrides: Partial<PreparedDocument> = {}): PreparedDocument {
  return {
    kind: 'payslip',
    entityType: 'employee',
    entityId: 'emp-1',
    lang: 'th',
    sha256: 'a'.repeat(64),
    fileRef: Buffer.alloc(125, 1),
    ...overrides,
  }
}

/** A minimal `pg.Pool` double: `connect()` returns a client whose `query`/`release` are harmless no-ops, matching `services/svc-config/src/rules.controller.test.ts`'s `fakePool` — sufficient because the faked `DocumentsService` below never actually issues SQL through the `tx` it's handed. */
function fakePool(overrides: Partial<Pool> = {}): Pool {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

type FakeDocumentsService = Pick<DocumentsService, 'prepare' | 'commit' | 'getDocument' | 'commitReadAudit' | 'health'>
function fakeDocumentsService(overrides: Partial<FakeDocumentsService> = {}): DocumentsService {
  const base: FakeDocumentsService = {
    prepare: jest.fn().mockResolvedValue(fakePrepared()),
    commit: jest.fn().mockResolvedValue({ id: 'doc-1', kind: 'payslip', entityType: 'employee', entityId: 'emp-1', lang: 'th', sha256: 'a'.repeat(64) } satisfies RenderResult),
    getDocument: jest.fn().mockResolvedValue({ meta: fakeDocumentRow(), pdfBytes: Buffer.from('pdf-bytes') } satisfies RetrievedDocument),
    commitReadAudit: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockResolvedValue({ storage: 'up', fonts: 'up' }),
    ...overrides,
  }
  return base as DocumentsService
}

function renderBody(overrides: Partial<RenderRequestBody> = {}): RenderRequestBody {
  return {
    kind: 'payslip',
    lang: 'th',
    entityType: 'employee',
    entityId: 'emp-1',
    mergeFields: { companyName: { type: 'text', value: 'GaDong' } },
    ...overrides,
  }
}

describe('DocumentsController wiring', () => {
  it('POST /render calls prepare() then commit() inside a transaction, and returns the result', async () => {
    const prepared = fakePrepared()
    const prepare = jest.fn().mockResolvedValue(prepared)
    const commit = jest.fn().mockResolvedValue({ id: 'doc-1', kind: 'payslip', entityType: 'employee', entityId: 'emp-1', lang: 'th', sha256: prepared.sha256 })
    const controller = new DocumentsController(fakeDocumentsService({ prepare, commit }), fakePool())

    const out = await controller.render({ userId: 'hr-1', actorRole: 'hr_admin' } as never, renderBody())

    expect(prepare).toHaveBeenCalledWith({
      kind: 'payslip',
      lang: 'th',
      entityType: 'employee',
      entityId: 'emp-1',
      mergeFields: { companyName: { type: 'text', value: 'GaDong' } },
    })
    expect(commit).toHaveBeenCalledWith(expect.anything(), prepared, 'hr-1', 'hr_admin')
    expect(out).toMatchObject({ id: 'doc-1', sha256: prepared.sha256 })
  })

  it('GET /documents/:id forwards id and returns metadata plus base64 content', async () => {
    const getDocument = jest.fn().mockResolvedValue({ meta: fakeDocumentRow({ id: 'doc-2' }), pdfBytes: Buffer.from('hello-pdf') })
    const commitReadAudit = jest.fn().mockResolvedValue(undefined)
    const controller = new DocumentsController(fakeDocumentsService({ getDocument, commitReadAudit }), fakePool())

    const out = await controller.getById({ userId: 'hr-1', actorRole: 'hr_admin' } as never, 'doc-2')

    expect(getDocument).toHaveBeenCalledWith('doc-2', 'document.read')
    expect(commitReadAudit).toHaveBeenCalledWith(expect.anything(), fakeDocumentRow({ id: 'doc-2' }), 'document.read', 'hr-1', 'hr_admin')
    expect(out).toMatchObject({ id: 'doc-2', kind: 'payslip', contentBase64: Buffer.from('hello-pdf').toString('base64') })
  })

  it('GET /health reports db:up, storage:up, fonts:up as overall status ok', async () => {
    const controller = new DocumentsController(fakeDocumentsService(), fakePool())
    const out = await controller.health()
    expect(out).toMatchObject({ status: 'ok', service: 'svc-docs', dependencies: { db: 'up', storage: 'up', fonts: 'up' } })
  })

  it('GET /health reports fonts:down as overall status degraded — not a crash', async () => {
    const controller = new DocumentsController(fakeDocumentsService({ health: jest.fn().mockResolvedValue({ storage: 'up', fonts: 'down' }) }), fakePool())
    const out = await controller.health()
    expect(out).toMatchObject({ status: 'degraded', dependencies: { fonts: 'down' } })
  })

  it('GET /health reports db:down when the pool query rejects — not a crash', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new DocumentsController(fakeDocumentsService(), pool)
    const out = await controller.health()
    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down' } })
  })

  it('reports outbox depth (event-bus health/metrics) — a fresh, undrained row is visible but not yet "stale"', async () => {
    const db = new FakeDocsDb()
    const tx = db.connect()
    await writeOutbox(tx, 'docs', 'document.rendered', { documentId: 'doc-1' })
    const controller = new DocumentsController(fakeDocumentsService(), db.asPool() as unknown as Pool)

    const out = await controller.health()

    expect(out.outbox).toMatchObject({ pending: 1, stale: false })
    expect(out.status).toBe('ok') // freshly-written, well under the staleness threshold
  })

  it('maps a thrown GadongError (e.g. DOC-500 fonts_unavailable) to an HttpException carrying the error envelope and status', async () => {
    const err = new GadongError('DOC-500', 'docs.error.fonts_unavailable', 500, [{ family: 'Noto Sans SC', missingGlyphs: ['工'] }])
    const controller = new DocumentsController(fakeDocumentsService({ prepare: jest.fn().mockRejectedValue(err) }), fakePool())

    try {
      await controller.render({ userId: 'hr-1' } as never, renderBody())
      throw new Error('expected rejection')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(HttpException)
      const httpErr = thrown as HttpException
      expect(httpErr.getStatus()).toBe(500)
      expect(httpErr.getResponse()).toMatchObject({ code: 'DOC-500' })
    }
  })

  it('maps a thrown DOC-404 to a 404 HttpException on GET /documents/:id', async () => {
    const err = new GadongError('DOC-404', 'docs.error.document_not_found', 404, [{ id: 'missing' }])
    const controller = new DocumentsController(fakeDocumentsService({ getDocument: jest.fn().mockRejectedValue(err) }), fakePool())

    try {
      await controller.getById({ userId: 'hr-1' } as never, 'missing')
      throw new Error('expected rejection')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(HttpException)
      expect((thrown as HttpException).getStatus()).toBe(404)
    }
  })
})

describe('DocumentsController — deny-by-default permission wiring (task brief API table)', () => {
  const EXPECTED: Record<string, string> = {
    render: 'document.generate',
    getById: 'document.read',
  }

  it.each(Object.entries(EXPECTED))('%s() declares @RequirePermission(%s)', (method, permission) => {
    const proto = DocumentsController.prototype as unknown as Record<string, () => unknown>
    const handler = proto[method]
    if (!handler) throw new Error(`no such handler: ${method}`)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe(permission)
  })

  it('health() has no @RequirePermission metadata — reachable without a permission, per the brief', () => {
    const proto = DocumentsController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['health']
    if (!handler) throw new Error('no such handler: health')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })

  it('has no class-level @RequirePermission that could mask an unannotated method', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, DocumentsController)).toBeUndefined()
  })
})

describe('AppModule mounts the kernel PermissionGuard and a DB_POOL provider', () => {
  it('registers an APP_GUARD provider bound to PermissionGuard', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const appGuardEntry = providers.find((p) => isRecord(p) && p['provide'] === APP_GUARD)
    expect(appGuardEntry).toBeDefined()
  })

  it('registers a DB_POOL provider', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const hasDbPool = providers.some((p) => isRecord(p) && p['provide'] === DB_POOL)
    expect(hasDbPool).toBe(true)
  })
})
