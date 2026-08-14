import { createHash } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import { AuditEmitter, CryptoClient, cryptoUnavailable, scopeAllowsEmployee, writeOutbox } from '@gadong/kernel'
import type { AuthzScope, Locale, Queryable } from '@gadong/kernel'
import { DocumentsRepository } from './documents.repository'
import type { DocumentRow, NewDocumentRow } from './documents.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import { PayslipRefRepository } from './payslip-ref.repository'
import { TemplateLoader } from './templates'
import type { WarnLogger } from './templates'
import { FontRegistry } from './fonts/font-registry'
import type { ExpectedFontFamily } from './fonts/font-registry'
import type { PdfRenderer } from './rendering/renderer'
import { htmlToPlainText } from './rendering/html-text'
import type { ObjectStorage } from './storage/object-storage'
import { resolveMergeFields, substituteTemplate } from './merge-fields'
import type { MergeFields } from './merge-fields'
import { documentNotFound, documentOutOfScope, fontsUnavailable, renderInputRequired } from './errors'

/**
 * `mergeFields` and `html` are mutually exclusive rendering INPUTS, not two
 * required fields — see `renderInputRequired`'s doc for why a caller
 * supplies one or the other, never both, never neither.
 */
export interface RenderRequest {
  kind: string
  lang: Locale
  entityType: string
  entityId: string
  mergeFields?: MergeFields
  html?: string
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
 * the document's HTML (either the `templates/` file with merge fields
 * substituted in, or a caller-supplied `html` string verbatim — see
 * `resolveHtml`), verify every embedded font actually covers the resulting
 * text — the fail-loud check that prevents the tofu-box failure the task
 * brief describes — render the PDF, put it in object storage, and
 * envelope-encrypt the storage pointer. `commit()` is the one DB write
 * (`INSERT` + `document.rendered` outbox event, same transaction, per
 * ADR-005) and is deliberately tiny and fast.
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
    private readonly employeeRefs: EmployeeRefRepository,
    private readonly payslipRefs: PayslipRefRepository,
    private readonly audit: AuditEmitter = new AuditEmitter(),
  ) {}

  /**
   * `html` (verbatim) wins if the caller supplied it — no template lookup,
   * no merge-field substitution, `effectiveLang` is simply the requested
   * `lang` (there is no template to fall back to `en` FROM). Otherwise
   * resolves `templates/<kind>.<lang>.html` (with its own `en` fallback)
   * and substitutes `mergeFields` into it — `resolveMergeFields`/
   * `substituteTemplate` throwing on a caller who supplied neither `html`
   * nor `mergeFields` for a `kind` that HAS no template (e.g. `payslip`,
   * once the caller-html path went live) would produce a confusing
   * "template not found" or "cannot read fields of undefined" error, so
   * this method validates the actual precondition — one of the two inputs
   * present — before either path runs, and reports it precisely.
   */
  private resolveHtml(input: RenderRequest): { html: string; effectiveLang: Locale } {
    if (input.html !== undefined) return { html: input.html, effectiveLang: input.lang }
    if (input.mergeFields === undefined) throw renderInputRequired(input.kind)

    const resolution = this.templates.resolve(input.kind, input.lang, this.warnLogger())
    const effectiveLang = resolution.lang as Locale
    const resolvedFields = resolveMergeFields(input.mergeFields, effectiveLang)
    return { html: substituteTemplate(resolution.html, resolvedFields, input.kind, effectiveLang), effectiveLang }
  }

  async prepare(input: RenderRequest): Promise<PreparedDocument> {
    const { html, effectiveLang } = this.resolveHtml(input)
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

  async commit(tx: Queryable, prepared: PreparedDocument, actorId = 'unknown', actorRole = 'unknown'): Promise<RenderResult> {
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

    // "document render (what template, for whom, by whom)" — roadmap
    // audit-coverage brief. `after` carries the template `kind`/`lang` and
    // WHICH entity the document is about, never the rendered content
    // itself (that only ever exists as `fileRef`, already S3-envelope
    // ciphertext, and as `sha256`, a content fingerprint — neither is a raw
    // field this hashes further, they are already opaque).
    await this.audit.emit(tx, 'docs', {
      actorId,
      actorRole,
      action: 'document.rendered',
      entity: 'document',
      entityId: row.id,
      after: { kind: row.kind, entityType: row.entityType, forEntityId: row.entityId, lang: row.lang },
    })

    return { id: row.id, kind: row.kind, entityType: row.entityType, entityId: row.entityId, lang: row.lang, sha256: row.sha256 }
  }

  /**
   * Row-scoping fix (roadmap "🔴 Open security gap"): `callerId`/`scope`
   * are REQUIRED, not optional (see `authz/scope.ts`'s design-decision
   * note in `@gadong/kernel` — an unscoped call site must not compile).
   * `scope` is `request.authzScope`, the `Decision.scopeOrgUnitIds` the
   * kernel `PermissionGuard` already fetched for `document.read` and
   * attached to the request — this method is the one place that applies
   * it, so no caller of `DocumentsService` can accidentally skip the
   * check.
   *
   * `scope === '*'` skips ownership resolution entirely (no read-model
   * lookup needed) — every other scope resolves the document's owning
   * employee via `resolveOwnerEmployeeId` and then applies kernel's
   * `scopeAllowsEmployee`, exactly the same function `svc-timesheet`'s
   * `views.service.ts` uses for the identical shape.
   *
   * **403, not a filtered-empty result** (see `errors.ts#documentOutOfScope`'s
   * doc): this is a single-id route — the caller named one specific
   * document. Unlike a list/aggregate route (where silently omitting
   * out-of-scope rows is the right call: an empty page leaks nothing an
   * attacker didn't already have to guess), a single-id GET has no
   * "empty" shape to fall back to that isn't itself either an error or a
   * lie (a 200 with no body would just be a worse-shaped 403). This
   * mirrors the precedent already shipped in this codebase —
   * `svc-timesheet`'s `TSH-070`/`TSH-071` — rather than inventing a new
   * convention.
   */
  async getDocument(id: string, callerId: string, scope: AuthzScope, purpose: string = DOCUMENT_READ_PURPOSE): Promise<RetrievedDocument> {
    const meta = await this.repo.findById(id)
    if (!meta) throw documentNotFound(id)

    if (scope !== '*') {
      const ownerEmployeeId = await this.resolveOwnerEmployeeId(meta)
      if (ownerEmployeeId === null) throw documentOutOfScope(id)

      // `scope === 'self'` never needs the owner's org unit (scopeAllowsEmployee
      // ignores it for that case) — only fetched for the array-scope path,
      // so a plain ESS self-read never pays for a read-model lookup.
      const ownerOrgUnitId = scope === 'self' ? null : (await this.employeeRefs.findById(ownerEmployeeId))?.orgUnitId ?? null
      if (!scopeAllowsEmployee(scope, callerId, ownerEmployeeId, ownerOrgUnitId)) throw documentOutOfScope(id)
    }

    const pointerJson = await this.crypto.decrypt(meta.entityId, 'file_ref', meta.fileRef, purpose)
    const pointer = JSON.parse(pointerJson) as { bucket: string; key: string }
    const pdfBytes = await this.storage.get(pointer.bucket, pointer.key)
    return { meta, pdfBytes }
  }

  /**
   * `GET /documents/:id` is an audited S3 read AND the only way this
   * service lets a caller download a document — one audit entry covers
   * both "read" and "download" (roadmap audit-coverage brief; there is no
   * separate download route to instrument). `getDocument` itself stays
   * DB-write-free (MinIO GET + decrypt, both slow I/O — same reasoning as
   * `prepare()`'s doc); this commits the audit entry as its own fast write,
   * matching `PayProfilesService.commitProfileReadAudit`'s split. Action
   * ends in `.sensitive.read` so kernel `AuditEmitter.emit` itself rejects
   * a blank purpose.
   */
  async commitReadAudit(tx: Queryable, meta: DocumentRow, purpose: string, actorId: string, actorRole: string): Promise<void> {
    await this.audit.emit(tx, 'docs', {
      actorId,
      actorRole,
      action: 'document.sensitive.read',
      entity: 'document',
      entityId: meta.id,
      purpose,
    })
  }

  /**
   * `docs.document` carries no direct employee owner for every `kind` —
   * see `payslip-ref.repository.ts`'s doc for why `entity_type = 'payslip'`
   * needs a separate lookup (`entity_id` is the payslip's own id, not the
   * employee's). Returns `null` — fail closed, never fail open — for any
   * `entity_type` this method does not have a resolution path for, and for
   * a `'payslip'` document whose `payslip.issued` event has not been
   * consumed yet (the read model lagging the write is a real, transient
   * state, not grounds to skip the check).
   */
  private async resolveOwnerEmployeeId(meta: DocumentRow): Promise<string | null> {
    if (meta.entityType === 'employee') return meta.entityId
    if (meta.entityType === 'payslip') {
      const ref = await this.payslipRefs.findById(meta.entityId)
      return ref?.employeeId ?? null
    }
    return null
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
