import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codePointCovered, parseCmapRanges } from './ttf-cmap'

const FONTS_DIR = join(__dirname, '..', '..', 'templates', 'fonts')

function codePointsOf(text: string): number[] {
  return [...text].map((ch) => {
    const cp = ch.codePointAt(0)
    if (cp === undefined) throw new Error('unreachable')
    return cp
  })
}

/**
 * These tests parse the REAL embedded font files this service ships
 * (`templates/fonts/*.ttf`, downloaded from Google Fonts — Sarabun, Noto
 * Sans SC, Noto Sans, all OFL-licensed) with this module's own binary
 * `cmap` parser — no font library is in this workspace's lockfile, so this
 * is genuine end-to-end proof that the parser correctly reads a real
 * font's Unicode coverage table, not a fixture built to make the parser
 * look correct.
 */
describe('parseCmapRanges — real embedded font files', () => {
  it('Sarabun (Thai) covers every character of "สลิปเงินเดือน" (payslip) and "ค่าจ้าง" (wage)', () => {
    const ranges = parseCmapRanges(readFileSync(join(FONTS_DIR, 'Sarabun-Regular.ttf')))
    for (const cp of codePointsOf('สลิปเงินเดือนค่าจ้าง')) {
      expect(codePointCovered(ranges, cp)).toBe(true)
    }
  })

  it('Sarabun also covers plain ASCII (Latin letters, digits, punctuation, the Baht sign) — templates mix scripts', () => {
    const ranges = parseCmapRanges(readFileSync(join(FONTS_DIR, 'Sarabun-Regular.ttf')))
    for (const cp of codePointsOf('ABCabc123,.฿-')) {
      expect(codePointCovered(ranges, cp)).toBe(true)
    }
  })

  it('Sarabun does NOT cover CJK — 工 (U+5DE5) has no glyph in a Thai font', () => {
    const ranges = parseCmapRanges(readFileSync(join(FONTS_DIR, 'Sarabun-Regular.ttf')))
    expect(codePointCovered(ranges, '工'.codePointAt(0)!)).toBe(false)
  })

  it('Noto Sans SC covers every character of "工资条" (payslip) and "社会保险基金" (Social Security Fund)', () => {
    const ranges = parseCmapRanges(readFileSync(join(FONTS_DIR, 'NotoSansSC-Regular.ttf')))
    for (const cp of codePointsOf('工资条社会保险基金')) {
      expect(codePointCovered(ranges, cp)).toBe(true)
    }
  })

  it('Noto Sans SC does NOT cover Thai — ส (U+0E2A) has no glyph in a CJK-only font', () => {
    const ranges = parseCmapRanges(readFileSync(join(FONTS_DIR, 'NotoSansSC-Regular.ttf')))
    expect(codePointCovered(ranges, 'ส'.codePointAt(0)!)).toBe(false)
  })

  it('Noto Sans covers Latin text and does not cover Thai or CJK', () => {
    const ranges = parseCmapRanges(readFileSync(join(FONTS_DIR, 'NotoSans-Regular.ttf')))
    for (const cp of codePointsOf('Payslip 123')) {
      expect(codePointCovered(ranges, cp)).toBe(true)
    }
    expect(codePointCovered(ranges, 'ส'.codePointAt(0)!)).toBe(false)
    expect(codePointCovered(ranges, '工'.codePointAt(0)!)).toBe(false)
  })

  it('throws on a buffer that is not a valid sfnt font (too short / bad magic)', () => {
    expect(() => parseCmapRanges(Buffer.from('not a font'))).toThrow(/not a supported sfnt font|too short/)
  })
})

describe('codePointCovered — binary search over merged ranges', () => {
  const ranges = parseCmapRanges(readFileSync(join(FONTS_DIR, 'Sarabun-Regular.ttf')))

  it('is false for a codepoint just outside every range', () => {
    // U+10FFFF is the maximum valid Unicode code point and Sarabun (a Thai
    // Latin-script font) has no glyph anywhere near it.
    expect(codePointCovered(ranges, 0x10ffff)).toBe(false)
  })
})
