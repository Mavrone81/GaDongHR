import { createHash } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import { CryptoClient, cryptoUnavailable, writeOutbox } from '@gadong/kernel'
import type { Locale, Queryable } from '@gadong/kernel'
import { DocumentsRepository } from './documents.repository'
import type { DocumentRow, NewDocumentRow } from './documents.repository'
import { TemplateLoader } from './templates'
import type { WarnLogger } from './templates'
import { FontRegistry } from './fonts/font-registry'
import type { ExpectedFontFamily } from './fonts/font-registry'
import type { PdfRenderer } from './rendering/renderer'
import { htmlToPlainText } from './rendering/html-text'
import type { ObjectStorage } from './storage/object-storage'
import { resolveMergeFields, substituteTemplate } from './merge-fields'
import type { MergeFields } from './merge-fields'
import { documentNotFound, fontsUnavailable } from './errors'

export interface RenderRequest {
  kind: string
  lang: Locale
  entityType: string
  entityId: string
  mergeFields: MergeFields
}

/** Everything committed to `docs.document` needs, computed BEFORE any database transaction opens — deliberately: rendering, encryption, and the MinIO put are all slow, external I/O, and must not hold a DB connection while they run (unlike `svc-config`'s pure-DB writes, this service's write path has real network calls in it). */
export interface PreparedDocument {
  kind: string
  entityType: string
  entityId: string
  lang: string
  sha256: string
  fileRef: Buffer
}

export interface RenderResult {
  id: string
  kind: string
  entityType: string
  entityId: string
  lang: string
  sha256: string
}

export interface RetrievedDocument {
  meta: DocumentRow
  pdfBytes: Buffer
}

/** Which embedded font family is primary for each language, per I18N-GUIDE.md §1 rule 6. */
const PRIMARY_FONT_FOR_LOCALE: Record<Locale, ExpectedFontFamily> = {
  th: 'Sarabun',
  zh: 'Noto Sans SC',
  en: 'Noto Sans',
}

/** The purpose recorded against every `GET /documents/:id` decrypt, matching this route's own permission name — svc-crypto's audit trail requires a non-blank purpose for every S3-class decrypt (kernel `CryptoClient.decrypt`), and there is no more specific "why" than "an authorised caller read the document". */
export const DOCUMENT_READ_PURPOSE = 'document.read'

/**
 * The business logic behind `POST /render` and `GET /documents/:id` — no
 * SQL here (`documents.repository.ts` owns that), matching the
 * `services/svc-config` `service`/no-SQL split.
 *
 * `prepare()` does every side effect that is NOT a database write: resolve
 * the template (with `en` fallback), substitute merge fields (dates/money
 * through the kernel's Buddhist-Era/THB formatters), verify every embedded
 * font actually covers the resulting text — the fail-loud check that
 * prevents the tofu-box failure the task brief describes — render the PDF,
 * put it in object storage, and envelope-encrypt the storage pointer.
 * `commit()` is the one DB write (`INSERT` + `document.rendered` outbox
 * event, same transaction, per ADR-005) and is deliberately tiny and fast.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name)

  constructor(
    private readonly repo: DocumentsRepository,
    private readonly templates: TemplateLoader,
    private readonly fonts: FontRegistry,
    private readonly renderer: PdfRenderer,
    private readonly storage: ObjectStorage,
    private readonly crypto: CryptoClient,
    private readonly bucket: string,
  ) {}

  async prepare(input: RenderRequest): Promise<PreparedDocument> {
    const resolution = this.templates.resolve(input.kind, input.lang, this.warnLogger())
    const effectiveLang = resolution.lang as Locale

    const resolvedFields = resolveMergeFields(input.mergeFields, effectiveLang)
    const html = substituteTemplate(resolution.html, resolvedFields, input.kind, effectiveLang)
    const plainText = htmlToPlainText(html)

    const missingGlyphs = this.missingGlyphsForLocale(effectiveLang, plainText)
    if (missingGlyphs.length > 0) {
      throw fontsUnavailable(PRIMARY_FONT_FOR_LOCALE[effectiveLang], missingGlyphs)
    }

    const rendered = await this.renderer.render({ html, fontFaces: this.fonts.describeLoaded() })
    const sha256 = createHash('sha256').update(rendered.pdfBytes).digest('hex')

    // Deterministic on {kind, entityId, lang, content}: the same render
    // request produces the same sha256 (FakePdfRenderer/ChromiumPdfRenderer
    // are both pure functions of `html` — no timestamp, no randomness), so
    // this key is stable across a regenerated payslip, and `put` below is a
    // same-key overwrite, not a proliferating pile of duplicate objects.
    const objectKey = `${input.kind}/${input.entityId}/${effectiveLang}/${sha256}.pdf`
    await this.storage.put(this.bucket, objectKey, rendered.pdfBytes)

    const pointer = JSON.stringify({ bucket: this.bucket, key: objectKey })
    const ciphertexts = await this.crypto.encryptBatch([
      { entityId: input.entityId, field: 'file_ref', value: pointer, fieldClass: 'S3' },
    ])
    const fileRef = ciphertexts.get('file_ref')
    // encryptBatch never returns successfully with a requested field missing
    // (kernel CryptoClient's contract) — this is defensive, not a real path.
    if (!fileRef) throw cryptoUnavailable()

    return {
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      lang: effectiveLang,
      sha256,
      fileRef,
    }
  }

  async commit(tx: Queryable, prepared: PreparedDocument): Promise<RenderResult> {
    const newRow: NewDocumentRow = {
      kind: prepared.kind,
      entityType: prepared.entityType,
      entityId: prepared.entityId,
      lang: prepared.lang,
      fileRef: prepared.fileRef,
      sha256: prepared.sha256,
    }
    const row = await this.repo.insert(tx, newRow)

    await writeOutbox(tx, 'docs', 'document.rendered', {
      documentId: row.id,
      kind: row.kind,
      entityType: row.entityType,
      entityId: row.entityId,
      lang: row.lang,
      sha256: row.sha256,
    })

    return { id: row.id, kind: row.kind, entityType: row.entityType, entityId: row.entityId, lang: row.lang, sha256: row.sha256 }
  }

  async getDocument(id: string, purpose: string = DOCUMENT_READ_PURPOSE): Promise<RetrievedDocument> {
    const meta = await this.repo.findById(id)
    if (!meta) throw documentNotFound(id)

    const pointerJson = await this.crypto.decrypt(meta.entityId, 'file_ref', meta.fileRef, purpose)
    const pointer = JSON.parse(pointerJson) as { bucket: string; key: string }
    const pdfBytes = await this.storage.get(pointer.bucket, pointer.key)
    return { meta, pdfBytes }
  }

  async health(): Promise<{ storage: 'up' | 'down'; fonts: 'up' | 'down' }> {
    const storage = await this.storage.health().catch(() => 'down' as const)
    return { storage, fonts: this.fonts.isHealthy() }
  }

  /**
   * Primary font first (Sarabun/Noto Sans SC/Noto Sans per language); any
   * character the primary font lacks is re-checked against every OTHER
   * loaded font, in registration order — the same multi-font CSS
   * `font-family` fallback stack a browser performs, done here so the check
   * runs before rendering rather than being discovered by an inspector
   * reading a finished PDF.
   *
   * This fallback is not just Latin punctuation/digits: `formatTHB` (kernel)
   * always renders the Thai Baht sign `฿` (U+0E3F) regardless of locale —
   * "the Baht sign ... [is] used regardless of locale", per that function's
   * own doc comment — and `฿` turns out to have NO glyph in either Noto Sans
   * or Noto Sans SC (verified against the real embedded files; only Sarabun
   * covers it). Without checking every loaded font, an English or Chinese
   * payslip's money amounts would fail this check — or worse, if the check
   * were narrower still, would have silently rendered as a tofu box for
   * `฿` specifically, in every non-Thai document that shows an amount.
   */
  private missingGlyphsForLocale(locale: Locale, text: string): string[] {
    const primary = PRIMARY_FONT_FOR_LOCALE[locale]
    let missing = this.fonts.missingGlyphs(primary, text)
    if (missing.length === 0) return []

    for (const family of this.fonts.loadedFamilies()) {
      if (family === primary || missing.length === 0) continue
      missing = this.fonts.missingGlyphs(family, missing.join(''))
    }
    return missing
  }

  private warnLogger(): WarnLogger {
    return { warn: (message: string) => this.logger.warn(message) }
  }
}
