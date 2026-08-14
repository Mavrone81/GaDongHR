import { GadongError } from '@gadong/kernel'

/** `GET /documents/:id` for an id that does not exist (or was never committed). */
export function documentNotFound(id: string): GadongError {
  return new GadongError('DOC-404', 'docs.error.document_not_found', 404, [{ id }])
}

/** Neither `templates/<kind>.<lang>.html` nor the `en` fallback exists — there is nothing to render at all, for any language. */
export function templateNotFound(kind: string, lang: string): GadongError {
  return new GadongError('DOC-404', 'docs.error.template_not_found', 404, [{ kind, lang }])
}

/** A `{{token}}` in the resolved template has no corresponding entry in the request's `mergeFields` — fails loudly rather than shipping a legal document with a literal `{{token}}` left in it. */
export function missingMergeFields(kind: string, lang: string, fields: string[]): GadongError {
  return new GadongError('DOC-422', 'docs.error.missing_merge_fields', 422, [{ kind, lang, fields }])
}

/**
 * `POST /render` needs either `mergeFields` (a template-owned document —
 * `kind` resolves to a file under `templates/`, e.g. an onboarding
 * contract) or `html` (a caller-owned document — the caller has already
 * composed its own complete, itemised HTML and only needs this service's
 * font-coverage check, PDF render, storage and encryption; e.g.
 * `svc-payroll`'s itemised payslip, whose per-line statutory citations and
 * YTD figures no fixed template captures). Neither present means there is
 * nothing to turn into a PDF.
 */
export function renderInputRequired(kind: string): GadongError {
  return new GadongError('DOC-400', 'docs.error.render_input_required', 400, [{ kind }])
}

/**
 * The document's text contains characters the fonts registered for its
 * language cannot draw — either because an expected font family never
 * loaded at all (a mis-built image) or because the text itself contains a
 * character genuinely outside that font's coverage. This is the fail-loud
 * counterpart to the tofu-box failure the brief describes: `render()`
 * refuses to hand such text to the PDF renderer at all, rather than
 * producing a PDF that "succeeded" and silently contains boxes.
 */
export function fontsUnavailable(family: string, missingGlyphs: string[]): GadongError {
  return new GadongError('DOC-500', 'docs.error.fonts_unavailable', 500, [{ family, missingGlyphs }])
}
