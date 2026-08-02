import type { PdfRenderer, RenderInput, RenderedDocument } from '../rendering/renderer'

/**
 * Stands in for `ChromiumPdfRenderer` in tests — there is no headless-
 * Chromium binary in this environment (CONSTRAINTS: "no real browser
 * here"). Deterministic (same `html` + same font family list always
 * produces the same bytes — no timestamp, no randomness) and preserves the
 * UTF-8 text verbatim in the output buffer, specifically so a
 * glyph-coverage test can assert the actual Thai/Chinese characters
 * (`สลิปเงินเดือน`, `工资条`, …) are present in the rendered bytes, not
 * merely that bytes were produced (`pdf.length > 0` is exactly the
 * worthless assertion this fake is built to let tests avoid).
 *
 * This is a stand-in for the PAINT step only. The font-registration and
 * glyph-coverage checks it never has to perform are real: they already ran,
 * for real, against the real embedded font files, in
 * `DocumentsService.prepare()` before this renderer is ever called — see
 * `font-registry.test.ts` and `documents.service.test.ts`.
 */
export class FakePdfRenderer implements PdfRenderer {
  private readonly calls: RenderInput[] = []

  async render(input: RenderInput): Promise<RenderedDocument> {
    this.calls.push(input)
    const header = `%FAKE-PDF-v1\nfonts:${input.fontFaces.map((f) => f.family).join(',')}\n---\n`
    return { pdfBytes: Buffer.from(header + input.html, 'utf8') }
  }

  renderCalls(): readonly RenderInput[] {
    return this.calls
  }
}
