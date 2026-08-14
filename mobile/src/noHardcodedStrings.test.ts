import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Ported from `web/src/i18n/noHardcodedStrings.test.tsx` — same idea, same
 * mechanism (parse every non-test `.tsx` with the real TS compiler, fail
 * on any `JsxText` node with non-whitespace content), run over `mobile/src`
 * instead of `web/src`. See that file's header for the full rationale.
 */
function findTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTsxFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scanFile(filePath: string): Violation[] {
  const source = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile);
      if (text.trim().length > 0) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({ file: filePath, line: line + 1, text: text.trim() });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe('no hard-coded user-visible strings in mobile/src/**/*.tsx', () => {
  const srcDir = join(__dirname);
  const files = findTsxFiles(srcDir);

  it('found at least one .tsx source file to scan (parser sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('has no literal JSX text content anywhere outside an i18n t() call', () => {
    const violations = files.flatMap(scanFile);
    const formatted = violations.map((v) => `${v.file}:${String(v.line)} -> "${v.text}"`);
    expect(formatted).toEqual([]);
  });
});
