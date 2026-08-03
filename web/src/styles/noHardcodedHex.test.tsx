import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * "No component may hard-code a hex" (task brief) — every color in this
 * app is required to be a `var(--token)` from `styles/tokens.css`, the one
 * file allowed to define the literal hex values from `DESIGN.md`'s token
 * table. Scans every `.css`/`.tsx`/`.ts` file under `src/` (excluding
 * `tokens.css` itself and test files) for a `#`-prefixed hex color and
 * fails, naming file + line, on any match.
 */
const SRC_DIR = join(__dirname, '..')
const TOKENS_FILE = join(__dirname, 'tokens.css')
const HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/g

function findFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...findFiles(full, extensions))
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)) && !entry.name.includes('.test.')) {
      out.push(full)
    }
  }
  return out
}

interface Violation {
  file: string
  line: number
  match: string
}

function scanFile(filePath: string): Violation[] {
  if (filePath === TOKENS_FILE) return []
  const source = readFileSync(filePath, 'utf8')
  const violations: Violation[] = []
  source.split('\n').forEach((lineText, idx) => {
    const matches = lineText.match(HEX_PATTERN)
    if (matches) {
      for (const m of matches) {
        violations.push({ file: relative(SRC_DIR, filePath), line: idx + 1, match: m })
      }
    }
  })
  return violations
}

describe('no hard-coded hex colors outside styles/tokens.css', () => {
  const files = [...findFiles(SRC_DIR, ['.css']), ...findFiles(SRC_DIR, ['.tsx', '.ts'])]

  it('found at least one stylesheet to scan (sanity)', () => {
    expect(files.filter((f) => f.endsWith('.css')).length).toBeGreaterThan(0)
  })

  it('has no literal hex color anywhere except styles/tokens.css', () => {
    const violations = files.flatMap(scanFile)
    const formatted = violations.map((v) => `${v.file}:${String(v.line)} -> "${v.match}"`)
    expect(formatted).toEqual([])
  })
})
