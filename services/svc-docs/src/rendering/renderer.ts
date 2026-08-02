/** One font family this service can hand the renderer, with the file it should embed for that family. */
export interface FontFaceDeclaration {
  family: string
  path: string
}

export interface RenderInput {
  /** Fully merge-substituted HTML — every `{{token}}` already resolved (see `../merge-fields.ts`). */
  html: string
  /** Every font family `FontRegistry` has successfully loaded, so the renderer can embed exactly what was coverage-checked — never a family the coverage check didn't see. */
  fontFaces: FontFaceDeclaration[]
}

export interface RenderedDocument {
  pdfBytes: Buffer
}

/**
 * Injectable port to whatever turns merge-substituted HTML into PDF bytes.
 * `ChromiumPdfRenderer` (`./chromium-renderer.ts`) is the real, production
 * implementation — headless Chromium via `playwright-core`, per ADR-008.
 * There is no headless-Chromium binary in this environment (no `pnpm
 * exec playwright install` has run, and none is vendored), so tests inject
 * `FakePdfRenderer` (`../testing/fake-pdf-renderer.ts`) instead — see the
 * task report for exactly which assertions that leaves structural rather
 * than end-to-end.
 */
export interface PdfRenderer {
  render(input: RenderInput): Promise<RenderedDocument>
}
