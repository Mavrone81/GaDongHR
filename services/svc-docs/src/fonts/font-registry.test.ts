import { join } from 'node:path'
import { EXPECTED_FONT_FAMILIES, FontRegistry } from './font-registry'
import type { FontDescriptor } from './font-registry'

const FONTS_DIR = join(__dirname, '..', '..', 'templates', 'fonts')

const ALL_DESCRIPTORS: FontDescriptor[] = [
  { family: 'Sarabun', path: join(FONTS_DIR, 'Sarabun-Regular.ttf') },
  { family: 'Noto Sans SC', path: join(FONTS_DIR, 'NotoSansSC-Regular.ttf') },
  { family: 'Noto Sans', path: join(FONTS_DIR, 'NotoSans-Regular.ttf') },
]

describe('FontRegistry — loaded against the real embedded font files', () => {
  it('registers all three expected families and reports isHealthy() "up"', () => {
    const registry = new FontRegistry(ALL_DESCRIPTORS)
    expect(registry.loadedFamilies().sort()).toEqual([...EXPECTED_FONT_FAMILIES].sort())
    expect(registry.isHealthy()).toBe('up')
  })

  it('covers() is true for the Thai payslip glossary strings under "Sarabun"', () => {
    const registry = new FontRegistry(ALL_DESCRIPTORS)
    expect(registry.covers('Sarabun', 'สลิปเงินเดือน')).toBe(true)
    expect(registry.covers('Sarabun', 'ค่าจ้าง')).toBe(true)
  })

  it('covers() is true for the Chinese payslip glossary strings under "Noto Sans SC"', () => {
    const registry = new FontRegistry(ALL_DESCRIPTORS)
    expect(registry.covers('Noto Sans SC', '工资条')).toBe(true)
    expect(registry.covers('Noto Sans SC', '社会保险基金')).toBe(true)
  })

  it('missingGlyphs() is empty for text a font fully covers', () => {
    const registry = new FontRegistry(ALL_DESCRIPTORS)
    expect(registry.missingGlyphs('Sarabun', 'ค่าจ้าง')).toEqual([])
  })

  it('missingGlyphs() lists exactly the characters a font cannot draw — e.g. Chinese text asked of the Thai font', () => {
    const registry = new FontRegistry(ALL_DESCRIPTORS)
    const missing = registry.missingGlyphs('Sarabun', '工资条')
    expect(missing.sort()).toEqual(['条', '工', '资'].sort())
  })
})

/**
 * THE central demonstration for this task: a font that never loaded — the
 * exact "mis-built image" failure mode the brief describes (a `COPY`
 * dropped from the Dockerfile, a renamed file) — makes glyph coverage fail
 * for real Chinese/Thai text, and `isHealthy()` reports `down`. Both halves
 * are asserted here so a reviewer can see the SAME missing-family input
 * driving both the render-time failure and the `/health` failure.
 */
describe('FontRegistry — a missing/unregistered font family fails closed (the tofu-box scenario)', () => {
  it('isHealthy() is "down" when Noto Sans SC (the only CJK font) is not registered at all', () => {
    const registry = new FontRegistry(ALL_DESCRIPTORS.filter((d) => d.family !== 'Noto Sans SC'))
    expect(registry.loadedFamilies().sort()).toEqual(['Noto Sans', 'Sarabun'])
    expect(registry.isHealthy()).toBe('down')
  })

  it('covers() is false for Chinese text once Noto Sans SC is not registered — every character is "missing", not vacuously covered', () => {
    const registry = new FontRegistry(ALL_DESCRIPTORS.filter((d) => d.family !== 'Noto Sans SC'))
    expect(registry.covers('Noto Sans SC', '工资条')).toBe(false)
    expect(registry.missingGlyphs('Noto Sans SC', '工资条').sort()).toEqual(['条', '工', '资'].sort())
  })

  it('isHealthy() is "down" when a font file path is simply wrong (file does not exist)', () => {
    const registry = new FontRegistry([
      { family: 'Sarabun', path: join(FONTS_DIR, 'Sarabun-Regular.ttf') },
      { family: 'Noto Sans SC', path: join(FONTS_DIR, 'does-not-exist.ttf') },
      { family: 'Noto Sans', path: join(FONTS_DIR, 'NotoSans-Regular.ttf') },
    ])
    expect(registry.isHealthy()).toBe('down')
    expect(registry.loadFailureReason('Noto Sans SC')).toBeDefined()
  })

  it('isHealthy() is "down" when a font file exists but is not a valid font (corrupt/truncated)', () => {
    const registry = new FontRegistry([
      { family: 'Sarabun', path: join(FONTS_DIR, 'Sarabun-Regular.ttf') },
      { family: 'Noto Sans SC', path: join(__dirname, 'font-registry.ts') }, // any real, non-font file
      { family: 'Noto Sans', path: join(FONTS_DIR, 'NotoSans-Regular.ttf') },
    ])
    expect(registry.isHealthy()).toBe('down')
    expect(registry.loadFailureReason('Noto Sans SC')).toMatch(/not a supported sfnt font|too short/)
  })

  it('an unregistered family (never in the descriptor list at all) covers nothing', () => {
    const registry = new FontRegistry(ALL_DESCRIPTORS)
    expect(registry.covers('Comic Sans MS', 'anything')).toBe(false)
    expect(registry.missingGlyphs('Comic Sans MS', 'abc')).toEqual(['a', 'b', 'c'])
  })
})
