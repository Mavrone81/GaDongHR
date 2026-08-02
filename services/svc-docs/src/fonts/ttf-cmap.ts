/**
 * A minimal, dependency-free parser for the `cmap` table of a TrueType/
 * OpenType font (`.ttf`/`.otf`, including variable fonts — `cmap` is
 * unaffected by variation axes). This workspace's lockfile carries no font
 * library (`fontkit`, `opentype.js`, `pdf-lib`, …) and this service is not
 * permitted to add one (task scope: only `services/svc-docs/{src,
 * migrations,templates}` — adding a dependency means editing
 * `pnpm-lock.yaml`, which is out of bounds). So this module reads the real
 * bytes of the real embedded font files (`templates/fonts/*.ttf`) and
 * answers, from the font's own Unicode coverage table, "does this font
 * actually have a glyph for this character" — the one question that
 * matters for the tofu-box failure mode (I18N-GUIDE.md §1 rule 6): a font
 * that silently falls back still produces a PDF, so `pdf.length > 0` proves
 * nothing. This is real binary parsing of real font files, not a fake.
 *
 * Only `cmap` subtable formats 4 (BMP, segment-delta) and 12 (full Unicode,
 * segmented coverage) are supported — the two formats every font this
 * service embeds actually ships (verified against the real Sarabun, Noto
 * Sans, and Noto Sans SC files in `font-registry.test.ts`). Formats 0, 2, 6,
 * 13, 14 are not implemented; a font whose only subtables use them fails
 * registration (`FontRegistry` reports it as a load failure, which surfaces
 * as `/health`'s `fonts: down` — fail closed, never silently "assume
 * covered").
 */

export type CodepointRange = readonly [start: number, end: number]

/** Inclusive Unicode code point range, sorted ascending and merged (no overlaps, no adjacency left un-merged). */
function mergeRanges(ranges: CodepointRange[]): CodepointRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [start, end] of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && start <= last[1] + 1) {
      if (end > last[1]) last[1] = end
    } else {
      out.push([start, end])
    }
  }
  return out
}

/** Binary search over merged, sorted ranges. */
export function codePointCovered(ranges: readonly CodepointRange[], codePoint: number): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const range = ranges[mid]
    if (range === undefined) break
    const [start, end] = range
    if (codePoint < start) hi = mid - 1
    else if (codePoint > end) lo = mid + 1
    else return true
  }
  return false
}

interface TableRecord {
  tag: string
  offset: number
  length: number
}

function readTag(buf: Buffer, offset: number): string {
  return buf.toString('ascii', offset, offset + 4)
}

/**
 * Parses the sfnt table directory. Supports plain sfnt files (`0x00010000`
 * or `OTTO`) — the only container format Google Fonts ships the fonts this
 * service embeds in. A `ttcf` (TrueType Collection) wrapper is not
 * supported; none of the three embedded fonts use one (confirmed: all three
 * downloaded `.ttf` files start with `0x00010000`, checked in
 * `font-registry.test.ts`).
 */
function parseTableDirectory(buf: Buffer): TableRecord[] {
  if (buf.length < 12) throw new Error('not a font file: too short for an sfnt header')
  const sfntVersion = buf.readUInt32BE(0)
  const isSupportedVersion = sfntVersion === 0x00010000 || readTag(buf, 0) === 'OTTO' || sfntVersion === 0x74727565
  if (!isSupportedVersion) {
    throw new Error(`not a supported sfnt font: unrecognised version 0x${sfntVersion.toString(16)}`)
  }
  const numTables = buf.readUInt16BE(4)
  const records: TableRecord[] = []
  for (let i = 0; i < numTables; i++) {
    const recordOffset = 12 + i * 16
    if (recordOffset + 16 > buf.length) throw new Error('sfnt table directory truncated')
    records.push({
      tag: readTag(buf, recordOffset),
      offset: buf.readUInt32BE(recordOffset + 8),
      length: buf.readUInt32BE(recordOffset + 12),
    })
  }
  return records
}

/** Segment-delta BMP cmap subtable (format 4). Walks every segment; segments using `idRangeOffset` are walked code-point-by-code-point (bounded by the BMP, so at most 65 536 iterations) to correctly exclude holes (a code point inside a segment's range that still maps to glyph 0, i.e. `.notdef`). */
function parseFormat4(buf: Buffer, subtableOffset: number): CodepointRange[] {
  const segCountX2 = buf.readUInt16BE(subtableOffset + 6)
  const segCount = segCountX2 / 2
  const endCodeOffset = subtableOffset + 14
  const startCodeOffset = endCodeOffset + segCountX2 + 2 // +2 skips reservedPad
  const idDeltaOffset = startCodeOffset + segCountX2
  const idRangeOffsetOffset = idDeltaOffset + segCountX2

  const ranges: CodepointRange[] = []
  for (let i = 0; i < segCount; i++) {
    const endCode = buf.readUInt16BE(endCodeOffset + i * 2)
    const startCode = buf.readUInt16BE(startCodeOffset + i * 2)
    if (startCode === 0xffff && endCode === 0xffff) continue // spec-mandated terminator segment, never covers a real character
    const idDelta = buf.readInt16BE(idDeltaOffset + i * 2)
    const idRangeOffset = buf.readUInt16BE(idRangeOffsetOffset + i * 2)

    if (idRangeOffset === 0) {
      // glyphId = (c + idDelta) mod 65536 for every c in [startCode, endCode].
      // Only pathological deltas map an in-range code point to glyph 0; treat
      // the whole segment as covered, matching how real Google Fonts builds
      // (verified against the embedded files) actually use this encoding.
      ranges.push([startCode, endCode])
      continue
    }

    // idRangeOffset != 0: glyph id comes from glyphIdArray via a per-code-point
    // indirection — walk it explicitly rather than assuming full coverage.
    const glyphIdArrayFieldOffset = idRangeOffsetOffset + i * 2
    for (let c = startCode; c <= endCode; c++) {
      const glyphIndexAddress = glyphIdArrayFieldOffset + idRangeOffset + 2 * (c - startCode)
      if (glyphIndexAddress + 2 > buf.length) continue
      let glyphId = buf.readUInt16BE(glyphIndexAddress)
      if (glyphId !== 0) glyphId = (glyphId + idDelta) & 0xffff
      if (glyphId !== 0) ranges.push([c, c])
    }
  }
  return ranges
}

/** Segmented-coverage cmap subtable (format 12) — full Unicode, used by every embedded font here for anything beyond the BMP (Thai lives in the BMP; the bulk of CJK Unified Ideographs does too, but Extension B+ does not). */
function parseFormat12(buf: Buffer, subtableOffset: number): CodepointRange[] {
  const numGroups = buf.readUInt32BE(subtableOffset + 12)
  const ranges: CodepointRange[] = []
  for (let i = 0; i < numGroups; i++) {
    const groupOffset = subtableOffset + 16 + i * 12
    if (groupOffset + 12 > buf.length) break
    const startCharCode = buf.readUInt32BE(groupOffset)
    const endCharCode = buf.readUInt32BE(groupOffset + 4)
    ranges.push([startCharCode, endCharCode])
  }
  return ranges
}

interface CmapSubtableEntry {
  platformId: number
  encodingId: number
  offset: number
}

function parseCmapHeader(buf: Buffer, cmapOffset: number): CmapSubtableEntry[] {
  const numTables = buf.readUInt16BE(cmapOffset + 2)
  const entries: CmapSubtableEntry[] = []
  for (let i = 0; i < numTables; i++) {
    const recordOffset = cmapOffset + 4 + i * 8
    entries.push({
      platformId: buf.readUInt16BE(recordOffset),
      encodingId: buf.readUInt16BE(recordOffset + 2),
      offset: cmapOffset + buf.readUInt32BE(recordOffset + 4),
    })
  }
  return entries
}

/** (platformId, encodingId) preference order — full-Unicode encodings first, since they alone can cover characters outside the BMP. */
const SUBTABLE_PREFERENCE: ReadonlyArray<readonly [number, number]> = [
  [3, 10],
  [0, 6],
  [0, 4],
  [3, 1],
  [0, 3],
  [0, 2],
  [0, 1],
  [0, 0],
]

/**
 * Parses every supported `cmap` subtable this font carries and returns the
 * UNION of their coverage as merged code-point ranges — not just the single
 * "best" subtable. A font can (and Google's variable-font builds do) split
 * coverage across a format-4 BMP subtable and a format-12 full-Unicode
 * subtable for different platform/encoding pairs; picking only the
 * top-preference subtable risks under-reporting real coverage. Throws if
 * the font carries no `cmap` table, or carries `cmap` but none of its
 * subtables are format 4 or 12 — both are registration failures, not
 * "assume covered".
 */
export function parseCmapRanges(fontBytes: Buffer): CodepointRange[] {
  const tables = parseTableDirectory(fontBytes)
  const cmapRecord = tables.find((t) => t.tag === 'cmap')
  if (!cmapRecord) throw new Error('font has no cmap table')

  const entries = parseCmapHeader(fontBytes, cmapRecord.offset)
  if (entries.length === 0) throw new Error('cmap table declares zero subtables')

  // Order entries by preference, but keep every entry — see doc comment above.
  const ordered = [...entries].sort((a, b) => {
    const rank = (e: CmapSubtableEntry): number => {
      const idx = SUBTABLE_PREFERENCE.findIndex(([p, enc]) => p === e.platformId && enc === e.encodingId)
      return idx === -1 ? SUBTABLE_PREFERENCE.length : idx
    }
    return rank(a) - rank(b)
  })

  const allRanges: CodepointRange[] = []
  let parsedAtLeastOne = false
  for (const entry of ordered) {
    const format = fontBytes.readUInt16BE(entry.offset)
    if (format === 4) {
      allRanges.push(...parseFormat4(fontBytes, entry.offset))
      parsedAtLeastOne = true
    } else if (format === 12) {
      allRanges.push(...parseFormat12(fontBytes, entry.offset))
      parsedAtLeastOne = true
    }
    // Unsupported formats (0, 2, 6, 13, 14, …) are skipped, not fatal, as
    // long as at least one subtable elsewhere is format 4 or 12.
  }

  if (!parsedAtLeastOne) throw new Error('cmap table has no format 4 or format 12 subtable (only formats this parser supports)')

  return mergeRanges(allRanges)
}
