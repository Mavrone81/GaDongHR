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
