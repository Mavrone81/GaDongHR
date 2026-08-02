import { readFileSync } from 'node:fs'
import { parseCmapRanges, codePointCovered } from './ttf-cmap'
import type { CodepointRange } from './ttf-cmap'

/**
 * The three families I18N-GUIDE.md §1 rule 6 requires embedded in every
 * `svc-docs` image: Sarabun (Thai), Noto Sans SC (Simplified Chinese), and
 * Noto Sans (Latin, and the fallback every template's incidental Latin
 * punctuation/digits render through). `/health`'s `fonts` dependency is
 * `down` when even one of these three is missing — that is the whole
 * mechanism that makes a mis-built image (a `COPY` dropped from the
 * Dockerfile, a renamed file) detectable without opening a PDF and hunting
 * for tofu boxes.
 */
export const EXPECTED_FONT_FAMILIES = ['Sarabun', 'Noto Sans SC', 'Noto Sans'] as const
export type ExpectedFontFamily = (typeof EXPECTED_FONT_FAMILIES)[number]

export interface FontDescriptor {
  /** Logical family name — what templates/merge logic ask for, e.g. `'Sarabun'`. Not necessarily the font's own internal `name` table string. */
  family: string
  /** Path to the embedded font file (`.ttf`). */
  path: string
}

interface LoadedFont {
  family: string
  path: string
  ranges: CodepointRange[]
}

/**
 * Loads the font files this service embeds and answers "does font X
 * actually have a glyph for character Y" from each font's own `cmap` table
 * (`./ttf-cmap`, real binary parsing — no font-rendering dependency is in
 * this workspace's lockfile, and this service isn't permitted to add one).
 *
 * `render()` in `documents.service.ts` calls `covers()`/`missingGlyphs()`
 * BEFORE ever handing a document's text to the PDF renderer — a family that
 * failed to load, or a character it genuinely has no glyph for, fails the
 * render loudly (`DOC-500` fonts-missing) rather than silently shipping a
 * tofu-box PDF that generates "successfully".
 */
export class FontRegistry {
  private readonly fonts = new Map<string, LoadedFont>()
  private readonly loadFailures = new Map<string, string>()

  constructor(descriptors: readonly FontDescriptor[]) {
    for (const d of descriptors) {
      try {
        const bytes = readFileSync(d.path)
        const ranges = parseCmapRanges(bytes)
        if (ranges.length === 0) throw new Error('cmap parsed but covers zero codepoints')
        this.fonts.set(d.family, { family: d.family, path: d.path, ranges })
      } catch (err) {
        this.loadFailures.set(d.family, err instanceof Error ? err.message : String(err))
      }
    }
  }

  has(family: string): boolean {
    return this.fonts.has(family)
  }

  /** Why `family` failed to load (missing file, unparseable `cmap`, …) — undefined if it loaded fine or was never requested. Surfaced in `/health` logs, never swallowed. */
  loadFailureReason(family: string): string | undefined {
    return this.loadFailures.get(family)
  }

  loadedFamilies(): string[] {
    return [...this.fonts.keys()]
  }

  /** `{family, path}` for every successfully loaded font — what `ChromiumPdfRenderer` embeds as `@font-face` declarations. Only families that actually passed `cmap` parsing are returned, so the renderer can never embed a family the coverage check above didn't see. */
  describeLoaded(): FontDescriptor[] {
    return [...this.fonts.values()].map((f) => ({ family: f.family, path: f.path }))
  }

  /** True when every character in `text` has a real glyph in `family`'s embedded font. An unregistered/failed-to-load family covers nothing — every character is "missing", never vacuously true. */
  covers(family: string, text: string): boolean {
    return this.missingGlyphs(family, text).length === 0
  }

  /** The distinct characters `family` has no glyph for. Every character in `text` when `family` never loaded at all — this is what lets a test demonstrate the tofu-box failure concretely instead of asserting a boolean. */
  missingGlyphs(family: string, text: string): string[] {
    const font = this.fonts.get(family)
    const missing = new Set<string>()
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      if (cp === undefined) continue
      if (!font || !codePointCovered(font.ranges, cp)) missing.add(ch)
    }
    return [...missing]
  }

  /** `up` only when every one of `EXPECTED_FONT_FAMILIES` loaded with real glyph coverage — this is exactly what `/health` reports as the `fonts` dependency. */
  isHealthy(): 'up' | 'down' {
    return EXPECTED_FONT_FAMILIES.every((family) => this.fonts.has(family)) ? 'up' : 'down'
  }
}
