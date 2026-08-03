import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEV_BYPASS_SIGNATURE } from './devBypass'

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

/**
 * Proves, rather than merely asserts, the guarantee `devBypass.ts`'s header
 * and web/README.md describe: the dev-only login bypass cannot exist in a
 * production build. Runs a REAL `vite build` (the exact command
 * `package.json`'s "build" script runs) into a throwaway directory and
 * greps every emitted JS file for this module's signature string — if
 * Vite's `import.meta.env.DEV` dead-code-elimination ever regressed (a
 * dependency bump, a config change), this test fails loudly instead of the
 * guarantee silently rotting.
 */
describe('production build excludes the dev-bypass code', () => {
  it('vite build emits no trace of the dev-bypass signature anywhere in dist', () => {
    const webDir = join(__dirname, '..', '..')
    const vitebin = join(webDir, 'node_modules', '.bin', 'vite')
    const outDir = mkdtempSync(join(tmpdir(), 'gadonghr-web-build-'))

    try {
      execFileSync(vitebin, ['build', '--outDir', outDir, '--emptyOutDir'], {
        cwd: webDir,
        stdio: 'pipe',
      })

      const files = listFiles(outDir).filter((f) => f.endsWith('.js'))
      expect(files.length).toBeGreaterThan(0)

      for (const file of files) {
        const content = readFileSync(file, 'utf8')
        expect(content).not.toContain(DEV_BYPASS_SIGNATURE)
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  }, 180_000)
})
