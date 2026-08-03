import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * DESIGN.md: "`--seal` is reserved. The moment it appears on something
 * that is not a legal citation, the citation stops reading as special and
 * the direction's whole argument collapses." Mechanically: `var(--seal)`
 * may only appear in `components/seal.css` (the citation stamp's own
 * stylesheet) and its class name `.seal` may only be assigned in
 * `components/Seal.tsx`. Every other `.css`/`.tsx`/`.ts` file under `src/`
 * fails this test if it references either.
 */
const SRC_DIR = join(__dirname, '..')
const ALLOWED_VAR_FILE = join(__dirname, '..', 'components', 'seal.css')
const ALLOWED_CLASS_FILE = join(__dirname, '..', 'components', 'Seal.tsx')

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

function scanFile(filePath: string, pattern: RegExp, allowedFiles: readonly string[]): Violation[] {
  if (allowedFiles.includes(filePath)) return []
  const source = readFileSync(filePath, 'utf8')
  const violations: Violation[] = []
  source.split('\n').forEach((lineText, idx) => {
    if (pattern.test(lineText)) {
      violations.push({ file: relative(SRC_DIR, filePath), line: idx + 1, match: lineText.trim() })
    }
    pattern.lastIndex = 0
  })
  return violations
}

describe('--seal is reserved for the citation Seal component only', () => {
  const cssFiles = findFiles(SRC_DIR, ['.css'])
  const codeFiles = findFiles(SRC_DIR, ['.tsx', '.ts'])

  it('found at least one stylesheet and one source file to scan (sanity)', () => {
    expect(cssFiles.length).toBeGreaterThan(0)
    expect(codeFiles.length).toBeGreaterThan(0)
  })

  it('references var(--seal) only from components/seal.css (or Seal.tsx\'s own doc comments)', () => {
    const varPattern = /var\(--seal\)/
    const violations = [...cssFiles, ...codeFiles].flatMap((f) =>
      scanFile(f, varPattern, [ALLOWED_VAR_FILE, ALLOWED_CLASS_FILE]),
    )
    const formatted = violations.map((v) => `${v.file}:${String(v.line)} -> "${v.match}"`)
    expect(formatted).toEqual([])
  })

  it('assigns the .seal class only from components/Seal.tsx', () => {
    const classPattern = /(className\s*=\s*["'`].*\bseal\b|['"`]\bseal\b['"`])/
    // Only scan .tsx/.ts sources for class assignment — CSS selectors for
    // `.seal` legitimately live in seal.css itself and are covered by the
    // var(--seal) check above, since every seal.css rule pairs the class
    // with the token.
    const violations = codeFiles.flatMap((f) => scanFile(f, classPattern, [ALLOWED_CLASS_FILE]))
    const formatted = violations.map((v) => `${v.file}:${String(v.line)} -> "${v.match}"`)
    expect(formatted).toEqual([])
  })
})
