/**
 * Reduces merge-substituted template HTML to the plain text that will
 * actually appear on the page — used for two things: (1) the font
 * glyph-coverage check in `documents.service.ts` (checking coverage of raw
 * HTML would wrongly flag `<`/`>`/entity markup as "characters the font
 * must draw"), and (2) as the string glyph-coverage tests search for
 * Thai/Chinese substrings in.
 *
 * Deliberately simple — this service's templates are its own
 * (`templates/*.html`), not arbitrary third-party markup, so a full HTML
 * parser is not needed to get a faithful "what text is on the page" answer.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
