import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import type { PdfRenderer, RenderInput, RenderedDocument } from './renderer'

function extensionFormat(path: string): string {
  return path.toLowerCase().endsWith('.otf') ? 'opentype' : 'truetype'
}

/** Base64 data-URI `@font-face` block per family, so the page needs no filesystem/network access at render time — everything the page can draw is embedded directly in the HTML handed to Chromium. */
function buildFontFaceCss(fontFaces: RenderInput['fontFaces']): string {
  return fontFaces
    .map((f) => {
      const bytes = readFileSync(f.path)
      const dataUri = `data:font/ttf;base64,${bytes.toString('base64')}`
      return `@font-face { font-family: '${f.family}'; src: url('${dataUri}') format('${extensionFormat(f.path)}'); font-weight: normal; font-style: normal; }`
    })
    .join('\n')
}

/**
 * The real, production `PdfRenderer` (ADR-008: "svc-docs renders documents
 * from HTML templates via headless Chromium with embedded Sarabun + Noto
 * Sans SC"). Launches Chromium via `playwright-core`, which requires a
 * browser binary installed at container build time (the Dockerfile in this
 * directory runs `pnpm exec playwright install --with-deps chromium`) —
 * `playwright-core` alone ships no browser.
 *
 * NOT EXERCISED by this task's test suite: there is no headless-Chromium
 * binary in this development environment (CONSTRAINTS: "no real browser
 * here"). Every other piece of the font/glyph story — font loading, cmap
 * parsing, coverage checking, template selection/fallback — is real code
 * proven against real font files in `font-registry.test.ts` and
 * `documents.service.test.ts`; only the final HTML→PDF paint step, done
 * here, is untested in this environment. See the task report's
 * "structural vs end-to-end" section.
 *
 * `executablePath` is optional and, when set, points at the OS-package
 * Chromium the Dockerfile installs via `apk add chromium` — Playwright's
 * own downloadable Chromium build is glibc-only and does not run on
 * `node:22-alpine`'s musl libc, a well-known Playwright/Alpine
 * incompatibility. Left undefined, Playwright falls back to its own
 * managed browser (useful for a non-Alpine dev machine that has run
 * `playwright-core install chromium`).
 */
export class ChromiumPdfRenderer implements PdfRenderer {
  constructor(private readonly executablePath?: string) {}

  async render(input: RenderInput): Promise<RenderedDocument> {
    const fontFaceCss = buildFontFaceCss(input.fontFaces)
    const fontFamilyStack = input.fontFaces.map((f) => `'${f.family}'`).join(', ')
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaceCss}\nbody { font-family: ${fontFamilyStack}, sans-serif; }</style></head><body>${input.html}</body></html>`

    const browser = await chromium.launch({ headless: true, executablePath: this.executablePath })
    try {
      const page = await browser.newPage()
      try {
        await page.setContent(html, { waitUntil: 'networkidle' })
        const pdfBytes = await page.pdf({ format: 'A4', printBackground: true })
        return { pdfBytes: Buffer.from(pdfBytes) }
      } finally {
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }
}
