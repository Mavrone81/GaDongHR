import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * "Zero hard-coded user-visible strings — that is checkable and will be
 * checked" (task brief). Mechanically: parses every non-test `.tsx` file
 * under `src/` with the real TypeScript compiler (not a regex) and fails,
 * naming file + line, on any `JsxText` node with non-whitespace content —
 * i.e. any text a human would actually read that was typed directly
 * between JSX tags instead of produced by `t('some.key')`. Attribute
 * values (`className`, `type="date"`, `htmlFor="..."`) are deliberately
 * NOT text nodes and are not scanned — only rendered content is.
 */
function findTsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...findTsxFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

interface Violation {
  file: string
  line: number
  text: string
}

function scanFile(filePath: string): Violation[] {
  const source = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: Violation[] = []

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile)
      if (text.trim().length > 0) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        violations.push({ file: filePath, line: line + 1, text: text.trim() })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

describe('no hard-coded user-visible strings in web/src/**/*.tsx', () => {
  const srcDir = join(__dirname, '..')
  const files = findTsxFiles(srcDir)

  it('found at least one .tsx source file to scan (parser sanity)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('has no literal JSX text content anywhere outside an i18n t() call', () => {
    const violations = files.flatMap(scanFile)
    const formatted = violations.map((v) => `${v.file}:${String(v.line)} -> "${v.text}"`)
    expect(formatted).toEqual([])
  })
})
