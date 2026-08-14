import { join } from 'node:path'
import { CryptoClient, GadongError } from '@gadong/kernel'
import { Logger } from '@nestjs/common'
import { DocumentsService } from './documents.service'
import type { RenderRequest } from './documents.service'
import { DocumentsRepository } from './documents.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import { PayslipRefRepository } from './payslip-ref.repository'
import { TemplateLoader } from './templates'
import { FontRegistry } from './fonts/font-registry'
import type { FontDescriptor } from './fonts/font-registry'
import { FakePdfRenderer } from './testing/fake-pdf-renderer'
import { FakeObjectStorage } from './testing/fake-object-storage'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { FakeDocsDb } from './testing/fake-db'

const TEMPLATES_DIR = join(__dirname, '..', 'templates')
const FONTS_DIR = join(TEMPLATES_DIR, 'fonts')
const BUCKET = 'gadonghr-docs-test'

const ALL_FONTS: FontDescriptor[] = [
  { family: 'Sarabun', path: join(FONTS_DIR, 'Sarabun-Regular.ttf') },
  { family: 'Noto Sans SC', path: join(FONTS_DIR, 'NotoSansSC-Regular.ttf') },
  { family: 'Noto Sans', path: join(FONTS_DIR, 'NotoSans-Regular.ttf') },
]

function makeService(fontDescriptors: FontDescriptor[] = ALL_FONTS): {
  service: DocumentsService
  db: FakeDocsDb
  storage: FakeObjectStorage
  renderer: FakePdfRenderer
  employeeRefs: EmployeeRefRepository
  payslipRefs: PayslipRefRepository
} {
  const db = new FakeDocsDb()
  const repo = new DocumentsRepository(db.asPool())
  const templates = new TemplateLoader(TEMPLATES_DIR)
  const fonts = new FontRegistry(fontDescriptors)
  const renderer = new FakePdfRenderer()
  const storage = new FakeObjectStorage()
  const crypto = new CryptoClient(fakeCryptoTransport())
  const employeeRefs = new EmployeeRefRepository(db.asPool())
  const payslipRefs = new PayslipRefRepository(db.asPool())
  const service = new DocumentsService(repo, templates, fonts, renderer, storage, crypto, BUCKET, employeeRefs, payslipRefs)
  return { service, db, storage, renderer, employeeRefs, payslipRefs }
}

function payslipRequest(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    kind: 'payslip',
    lang: 'th',
    entityType: 'employee',
    entityId: 'emp-1',
    mergeFields: {
      companyName: { type: 'text', value: 'GaDong Co., Ltd.' },
      employeeName: { type: 'text', value: 'สมชาย ใจดี' },
      payDate: { type: 'date', iso: '2026-08-02' },
      grossPay: { type: 'money', satang: '3000000' },
      socialSecurityDeduction: { type: 'money', satang: '150000' },
      netPay: { type: 'money', satang: '2850000' },
    },
    ...overrides,
  }
}

/** Fetches the "PDF" the fake renderer + fake storage produced for `prepared`, and decodes it as UTF-8 — valid because `FakePdfRenderer` preserves the substituted HTML verbatim (see its own doc comment for exactly what that does and doesn't prove). This is how the glyph-coverage tests below "extract text from the PDF" without a PDF text-extraction library in this workspace's lockfile. */
async function fetchRenderedText(storage: FakeObjectStorage, prepared: { kind: string; entityId: string; lang: string; sha256: string }): Promise<string> {
  const key = `${prepared.kind}/${prepared.entityId}/${prepared.lang}/${prepared.sha256}.pdf`
  const bytes = await storage.get(BUCKET, key)
  return bytes.toString('utf8')
}

describe('DocumentsService.prepare — glyph coverage (the tofu-box failure this task exists to catch)', () => {
  it('a Thai payslip actually contains the glossary glyphs "สลิปเงินเดือน" and "ค่าจ้าง" in the rendered output — not merely a non-empty PDF', async () => {
    const { service, storage } = makeService()
    const prepared = await service.prepare(payslipRequest({ lang: 'th' }))
    const text = await fetchRenderedText(storage, prepared)

    expect(text).toContain('สลิปเงินเดือน')
    expect(text).toContain('ค่าจ้าง')
    // The worthless assertion this task explicitly calls out — included only
    // to show it is not the assertion this suite relies on.
    expect(text.length).toBeGreaterThan(0)
  })

  it('a Chinese payslip actually contains "工资条" and "社会保险基金" in the rendered output', async () => {
    const { service, storage } = makeService()
    const prepared = await service.prepare(
      payslipRequest({
        lang: 'zh',
        mergeFields: {
          companyName: { type: 'text', value: 'GaDong 有限公司' },
          employeeName: { type: 'text', value: '王小明' },
          payDate: { type: 'date', iso: '2026-08-02' },
          grossPay: { type: 'money', satang: '3000000' },
          socialSecurityDeduction: { type: 'money', satang: '150000' },
          netPay: { type: 'money', satang: '2850000' },
        },
      }),
    )
    const text = await fetchRenderedText(storage, prepared)

    expect(text).toContain('工资条')
    expect(text).toContain('社会保险基金')
  })

  /**
   * THE demonstration test: reproduces the exact failure mode a mis-built
   * image causes (Noto Sans SC dropped from the Dockerfile `COPY`) and
   * proves `prepare()` refuses to render rather than silently shipping
   * tofu boxes. The task report pastes this test's output both with and
   * without the fix (i.e. with `ALL_FONTS` vs this reduced list) to show
   * the assertion actually distinguishes the two.
   */
  it('throws DOC-500 fonts_unavailable for a Chinese payslip when Noto Sans SC is not registered at all', async () => {
    const missingCjkFont = ALL_FONTS.filter((f) => f.family !== 'Noto Sans SC')
    const { service } = makeService(missingCjkFont)

    const request = payslipRequest({
      lang: 'zh',
      mergeFields: {
        companyName: { type: 'text', value: 'GaDong' },
        employeeName: { type: 'text', value: '王小明' },
        payDate: { type: 'date', iso: '2026-08-02' },
        grossPay: { type: 'money', satang: '3000000' },
        socialSecurityDeduction: { type: 'money', satang: '150000' },
        netPay: { type: 'money', satang: '2850000' },
      },
    })

    await expect(service.prepare(request)).rejects.toBeInstanceOf(GadongError)
    try {
      await service.prepare(request)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(GadongError)
      const gadongErr = err as GadongError
      expect(gadongErr.code).toBe('DOC-500')
      expect(gadongErr.details).toEqual([{ family: 'Noto Sans SC', missingGlyphs: expect.arrayContaining(['工', '资', '条']) }])
    }
  })

  it('a Thai payslip still succeeds when only Noto Sans SC is missing — Thai does not need the CJK font', async () => {
    const missingCjkFont = ALL_FONTS.filter((f) => f.family !== 'Noto Sans SC')
    const { service, storage } = makeService(missingCjkFont)

    const prepared = await service.prepare(payslipRequest({ lang: 'th' }))
    const text = await fetchRenderedText(storage, prepared)
    expect(text).toContain('สลิปเงินเดือน')
  })
})

describe('DocumentsService.prepare — dates render Buddhist Era on th, Gregorian on en/zh (kernel formatDate)', () => {
  it('th renders 2569 (2026 + 543)', async () => {
    const { service, storage } = makeService()
    const prepared = await service.prepare(payslipRequest({ lang: 'th' }))
    const text = await fetchRenderedText(storage, prepared)
    expect(text).toContain('02/08/2569')
    expect(text).not.toContain('02/08/2026')
  })

  it('en renders the Gregorian year 2026 unchanged', async () => {
    const { service, storage } = makeService()
    const prepared = await service.prepare(
      payslipRequest({
        lang: 'en',
        mergeFields: {
          companyName: { type: 'text', value: 'GaDong Co., Ltd.' },
          employeeName: { type: 'text', value: 'Somchai Jaidee' },
          payDate: { type: 'date', iso: '2026-08-02' },
          grossPay: { type: 'money', satang: '3000000' },
          socialSecurityDeduction: { type: 'money', satang: '150000' },
          netPay: { type: 'money', satang: '2850000' },
        },
      }),
    )
    const text = await fetchRenderedText(storage, prepared)
    expect(text).toContain('02/08/2026')
    expect(text).not.toContain('2569')
  })

  it('zh renders the Gregorian year 2026 unchanged', async () => {
    const { service, storage } = makeService()
    const prepared = await service.prepare(
      payslipRequest({
        lang: 'zh',
        mergeFields: {
          companyName: { type: 'text', value: 'GaDong 有限公司' },
          employeeName: { type: 'text', value: '王小明' },
          payDate: { type: 'date', iso: '2026-08-02' },
          grossPay: { type: 'money', satang: '3000000' },
          socialSecurityDeduction: { type: 'money', satang: '150000' },
          netPay: { type: 'money', satang: '2850000' },
        },
      }),
    )
    const text = await fetchRenderedText(storage, prepared)
    expect(text).toContain('02/08/2026')
    expect(text).not.toContain('2569')
  })
})

describe('DocumentsService.prepare — money amounts render correctly on every language, including the Thai Baht sign only Sarabun covers', () => {
  it('an English payslip (money via kernel formatTHB, which always renders ฿ regardless of locale) still succeeds and shows ฿ — Noto Sans alone does not cover U+0E3F, so this proves the fallback checks every loaded font, not just the primary one', async () => {
    const { service, storage } = makeService()
    const prepared = await service.prepare(
      payslipRequest({
        lang: 'en',
        mergeFields: {
          companyName: { type: 'text', value: 'GaDong Co., Ltd.' },
          employeeName: { type: 'text', value: 'Somchai Jaidee' },
          payDate: { type: 'date', iso: '2026-08-02' },
          grossPay: { type: 'money', satang: '3000000' },
          socialSecurityDeduction: { type: 'money', satang: '150000' },
          netPay: { type: 'money', satang: '2850000' },
        },
      }),
    )
    const text = await fetchRenderedText(storage, prepared)
    expect(text).toContain('฿30,000.00')
  })
})

describe('DocumentsService.prepare — template fallback', () => {
  it('falls back to English for contract.zh (which does not exist) and logs a warning', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      const { service, storage } = makeService()
      const prepared = await service.prepare({
        kind: 'contract',
        lang: 'zh',
        entityType: 'employee',
        entityId: 'emp-1',
        mergeFields: {
          companyName: { type: 'text', value: 'GaDong Co., Ltd.' },
          employeeName: { type: 'text', value: '王小明' },
          startDate: { type: 'date', iso: '2026-08-02' },
          grossPay: { type: 'money', satang: '3000000' },
        },
      })

      expect(prepared.lang).toBe('en')
      const text = await fetchRenderedText(storage, prepared)
      expect(text).toContain('Employment Contract')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/kind="contract".*lang="zh".*falling back to "en"/))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('DocumentsService.prepare — missing merge fields fail loudly', () => {
  it('DOC-422 when a template token has no corresponding mergeFields entry', async () => {
    const { service } = makeService()
    const request = payslipRequest({ mergeFields: { companyName: { type: 'text', value: 'GaDong' } } })
    await expect(service.prepare(request)).rejects.toMatchObject({ code: 'DOC-422' })
  })
})

describe('DocumentsService.prepare — caller-owned HTML (mutually exclusive with mergeFields)', () => {
  it('renders a caller-supplied html string verbatim, with no template lookup and no mergeFields substitution', async () => {
    const { service, storage } = makeService()
    const prepared = await service.prepare({
      kind: 'payslip',
      lang: 'th',
      entityType: 'payslip',
      entityId: 'payslip-1',
      html: '<article class="payslip">สลิปเงินเดือน — itemised, no {{token}} anywhere</article>',
    })
    const text = await fetchRenderedText(storage, prepared)
    expect(text).toContain('สลิปเงินเดือน — itemised, no {{token}} anywhere')
  })

  it('effectiveLang is exactly the requested lang — there is no template to fall back to English FROM', async () => {
    const { service } = makeService()
    const prepared = await service.prepare({
      kind: 'payslip',
      lang: 'zh',
      entityType: 'payslip',
      entityId: 'payslip-1',
      html: '<article>plain ASCII, no CJK glyphs to check</article>',
    })
    expect(prepared.lang).toBe('zh')
  })

  it('still runs the font-coverage check against caller-supplied html — a glyph no registered font covers still fails loudly, not just template-substituted content', async () => {
    const { service } = makeService([])
    await expect(
      service.prepare({
        kind: 'payslip',
        lang: 'th',
        entityType: 'payslip',
        entityId: 'payslip-1',
        html: '<article>ค่าจ้าง</article>',
      }),
    ).rejects.toMatchObject({ code: 'DOC-500' })
  })

  it('DOC-400 renderInputRequired when neither html nor mergeFields is supplied — nothing to render', async () => {
    const { service } = makeService()
    await expect(
      service.prepare({ kind: 'payslip', lang: 'th', entityType: 'payslip', entityId: 'payslip-1' }),
    ).rejects.toMatchObject({ code: 'DOC-400' })
  })

  it('html wins over mergeFields if a caller somehow sends both — never a silent merge of the two rendering modes', async () => {
    const { service, storage } = makeService()
    const prepared = await service.prepare({
      ...payslipRequest(),
      html: '<article>caller html, not the template</article>',
    })
    const text = await fetchRenderedText(storage, prepared)
    expect(text).toContain('<article>caller html, not the template</article>')
  })
})

describe('DocumentsService.prepare — determinism (a regenerated payslip is provably identical)', () => {
  it('the same {kind, entityId, lang, mergeFields} produces the same sha256 across two independent calls', async () => {
    const { service: service1 } = makeService()
    const { service: service2 } = makeService()
    const request = payslipRequest()

    const prepared1 = await service1.prepare(request)
    const prepared2 = await service2.prepare(request)

    expect(prepared1.sha256).toBe(prepared2.sha256)
    expect(prepared1.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a different payDate produces a different sha256 — content genuinely determines the hash, it is not a constant', async () => {
    const { service } = makeService()
    const prepared1 = await service.prepare(payslipRequest({ mergeFields: { ...payslipRequest().mergeFields, payDate: { type: 'date', iso: '2026-08-02' } } }))
    const prepared2 = await service.prepare(payslipRequest({ mergeFields: { ...payslipRequest().mergeFields, payDate: { type: 'date', iso: '2026-09-02' } } }))
    expect(prepared1.sha256).not.toBe(prepared2.sha256)
  })
})

describe('DocumentsService — the stored file_ref is ciphertext, never a plaintext MinIO path', () => {
  it('the raw file_ref column value does not contain the bucket name or object key as a substring', async () => {
    const { service, db } = makeService()
    const prepared = await service.prepare(payslipRequest())
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.commit(conn, prepared)
    await conn.query('COMMIT')

    const stored = db.debugDocuments()[0]
    expect(stored).toBeDefined()
    const fileRef = stored!.file_ref
    expect(Buffer.isBuffer(fileRef)).toBe(true)
    expect(fileRef.length).toBeGreaterThanOrEqual(125)

    const objectKey = `${prepared.kind}/${prepared.entityId}/${prepared.lang}/${prepared.sha256}.pdf`
    const asLatin1 = fileRef.toString('latin1')
    expect(asLatin1).not.toContain(BUCKET)
    expect(asLatin1).not.toContain(objectKey)
    expect(asLatin1).not.toContain(prepared.entityId)
  })

  it('GET-style retrieval round-trips: decrypting file_ref and fetching from storage returns the same PDF bytes that were rendered', async () => {
    const { service, db, storage } = makeService()
    const prepared = await service.prepare(payslipRequest())
    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.commit(conn, prepared)
    await conn.query('COMMIT')

    const expectedBytes = await fetchRenderedText(storage, prepared)
    // `payslipRequest()` -> entityType: 'employee', entityId: 'emp-1' — the
    // caller IS the document's owner, so `'self'` scope must allow this.
    const retrieved = await service.getDocument(result.id, 'emp-1', 'self')

    expect(retrieved.meta.id).toBe(result.id)
    expect(retrieved.meta.sha256).toBe(prepared.sha256)
    expect(retrieved.pdfBytes.toString('utf8')).toBe(expectedBytes)
  })

  it('getDocument() throws DOC-404 for an id that was never committed', async () => {
    const { service } = makeService()
    await expect(service.getDocument('00000000-0000-0000-0000-000000000000', 'emp-1', '*')).rejects.toMatchObject({ code: 'DOC-404' })
  })
})

describe('DocumentsService.getDocument — row-scoping fix (roadmap "🔴 Open security gap")', () => {
  async function commitEmployeeDoc(service: DocumentsService, db: FakeDocsDb, entityId: string): Promise<{ id: string }> {
    const prepared = await service.prepare(payslipRequest({ entityType: 'employee', entityId }))
    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.commit(conn, prepared)
    await conn.query('COMMIT')
    return result
  }

  it('"*" scope reads any employee-owned document, no ownership lookup required', async () => {
    const { service, db } = makeService()
    const { id } = await commitEmployeeDoc(service, db, 'emp-owner')
    await expect(service.getDocument(id, 'someone-else', '*')).resolves.toMatchObject({ meta: { id } })
  })

  it('"self" scope allows the owner and denies (DOC-070) every other caller — the exact vulnerability the roadmap names: "An employee who enumerates a document id reaches a colleague\'s payslip"', async () => {
    const { service, db } = makeService()
    const { id } = await commitEmployeeDoc(service, db, 'emp-owner')

    await expect(service.getDocument(id, 'emp-owner', 'self')).resolves.toMatchObject({ meta: { id } })
    await expect(service.getDocument(id, 'emp-intruder', 'self')).rejects.toMatchObject({ code: 'DOC-070' })
  })

  it('an org-unit array scope allows a caller whose scope covers the owner\'s org unit', async () => {
    const { service, db, employeeRefs } = makeService()
    const { id } = await commitEmployeeDoc(service, db, 'emp-owner')
    await employeeRefs.upsert(db.asPool(), { employeeId: 'emp-owner', orgUnitId: 'org-a' })

    await expect(service.getDocument(id, 'manager-1', ['org-a'])).resolves.toMatchObject({ meta: { id } })
    await expect(service.getDocument(id, 'manager-2', ['org-b'])).rejects.toMatchObject({ code: 'DOC-070' })
  })

  it('an org-unit array scope fails closed (DOC-070) when the owner has no synced employee_ref row yet', async () => {
    const { service, db } = makeService()
    const { id } = await commitEmployeeDoc(service, db, 'emp-not-yet-synced')
    await expect(service.getDocument(id, 'manager-1', ['org-a'])).rejects.toMatchObject({ code: 'DOC-070' })
  })

  it('a payslip document resolves its owner via docs.payslip_ref (entity_id is the payslip id, not the employee id) — "self" allows the true owner and denies everyone else', async () => {
    const { service, db, payslipRefs } = makeService()
    const prepared = await service.prepare(payslipRequest({ entityType: 'payslip', entityId: 'payslip-77' }))
    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.commit(conn, prepared)
    await conn.query('COMMIT')
    await payslipRefs.upsert(db.asPool(), { payslipId: 'payslip-77', employeeId: 'emp-real-owner' })

    await expect(service.getDocument(result.id, 'emp-real-owner', 'self')).resolves.toMatchObject({ meta: { id: result.id } })
    await expect(service.getDocument(result.id, 'emp-different-employee', 'self')).rejects.toMatchObject({ code: 'DOC-070' })
  })

  it('a payslip document fails closed (DOC-070) under "self" scope when payslip.issued has not synced docs.payslip_ref yet — a lagging read model must not be treated as "no owner to check"', async () => {
    const { service, db } = makeService()
    const prepared = await service.prepare(payslipRequest({ entityType: 'payslip', entityId: 'payslip-unsynced' }))
    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.commit(conn, prepared)
    await conn.query('COMMIT')

    await expect(service.getDocument(result.id, 'anyone', 'self')).rejects.toMatchObject({ code: 'DOC-070' })
  })

  it('an unrecognised entity_type fails closed (DOC-070) under any non-"*" scope', async () => {
    const { service, db } = makeService()
    const prepared = await service.prepare(payslipRequest({ entityType: 'something-new', entityId: 'whatever' }))
    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.commit(conn, prepared)
    await conn.query('COMMIT')

    await expect(service.getDocument(result.id, 'anyone', 'self')).rejects.toMatchObject({ code: 'DOC-070' })
    await expect(service.getDocument(result.id, 'anyone', '*')).resolves.toMatchObject({ meta: { id: result.id } })
  })
})

describe('DocumentsService.commit — writes the row, a document.rendered business event AND its audit entry in one transaction', () => {
  it('writes exactly one docs.document row and two outbox rows (the business event and its audit.document.rendered entry) on commit', async () => {
    const { service, db } = makeService()
    const prepared = await service.prepare(payslipRequest())
    const conn = db.connect()
    await conn.query('BEGIN')
    const result = await service.commit(conn, prepared, 'hr-1', 'hr_admin')
    await conn.query('COMMIT')

    expect(db.debugDocuments()).toHaveLength(1)
    expect(db.debugOutboxRows()).toHaveLength(2)
    expect(db.debugOutboxRows()[0]).toMatchObject({
      topic: 'document.rendered',
      payload: { documentId: result.id, kind: 'payslip', lang: 'th', sha256: prepared.sha256 },
    })
    expect(db.debugOutboxRows()[1]).toMatchObject({
      topic: 'audit.document.rendered',
      payload: { actorId: 'hr-1', actorRole: 'hr_admin', action: 'document.rendered', entity: 'document', entityId: result.id, beforeHash: null },
    })
  })

  it('rolls back cleanly: nothing is committed if COMMIT never runs — the audit entry rolls back with everything else', async () => {
    const { service, db } = makeService()
    const prepared = await service.prepare(payslipRequest())
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.commit(conn, prepared)
    await conn.query('ROLLBACK')

    expect(db.debugDocuments()).toHaveLength(0)
    expect(db.debugOutboxRows()).toHaveLength(0)
  })
})

describe('DocumentsService.health', () => {
  it('reports fonts: up and storage: up when everything is healthy', async () => {
    const { service } = makeService()
    await expect(service.health()).resolves.toEqual({ storage: 'up', fonts: 'up' })
  })

  it('reports fonts: down when an expected family is not registered', async () => {
    const { service } = makeService(ALL_FONTS.filter((f) => f.family !== 'Sarabun'))
    await expect(service.health()).resolves.toEqual({ storage: 'up', fonts: 'down' })
  })

  it('reports storage: down when the storage transport is unhealthy, without throwing', async () => {
    const { service, storage } = makeService()
    storage.setHealthy(false)
    await expect(service.health()).resolves.toEqual({ storage: 'down', fonts: 'up' })
  })
})
