// @vitest-environment node
//
// This suite boots a real `vite dev` server as a subprocess and fetches
// from it over real HTTP. (An earlier draft used Vite's programmatic
// `createServer` in-process, but that nests one esbuild service inside
// another — Vitest's own transform pipeline is already esbuild-backed —
// and the two collide ("The build was canceled", hangs on teardown). A
// real subprocess, exactly what `pnpm --filter @gadong/web dev` runs, has
// no such collision and is closer to what actually broke in Chrome.)
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

// `spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] })` below has no stdin
// (`null`), hence `ChildProcessByStdio<null, Readable, Readable>` rather
// than `ChildProcessWithoutNullStreams` (which requires a writable stdin).
type DevServerProcess = ChildProcessByStdio<null, Readable, Readable>

/**
 * THE regression this test guards against: `pnpm --filter @gadong/web dev`
 * served HTTP 200, set the right `<title>`, and painted nothing. Every
 * other test in this package — Vitest's `App.test.tsx`,
 * `App.rendersReadableText.test.tsx`, the Jest suite — passed throughout,
 * because Vitest and Jest both transform TypeScript with esbuild, which
 * tolerates `Money.tsx`/`DateText.tsx`/`i18n/locale.ts` importing
 * `@gadong/kernel/dist/i18n/format` (CommonJS — `tsconfig.base.json` sets
 * `module: "commonjs"` for the whole monorepo). `vite dev` does not use
 * esbuild's CJS interop for module transforms the way Vitest does: it
 * serves that file to the browser byte-for-byte, `exports` is undefined in
 * a browser ES module, the import throws, the module graph dies before any
 * React code runs, and no listener is ever attached — so there is no
 * console error either. `devBypass.build.test.tsx` runs a real `vite
 * build` and would not have caught this (`build.commonjsOptions` handles
 * CJS interop through Rollup; `vite dev` never goes through Rollup at
 * all). Only booting a REAL `vite dev` server and fetching over real HTTP,
 * as this test does, exercises the code path that broke.
 */
describe('a real `vite dev` server serves an app that can actually mount', () => {
  const webDir = join(__dirname, '..')
  const viteBin = join(webDir, 'node_modules', '.bin', 'vite')
  let child: DevServerProcess | undefined

  afterEach(async () => {
    if (!child) return
    const dead = child
    child = undefined
    dead.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      dead.once('exit', () => resolve())
      // Belt and braces: if SIGTERM doesn't land within 5s, don't hang the
      // suite — force-kill and move on.
      setTimeout(() => {
        dead.kill('SIGKILL')
        resolve()
      }, 5_000)
    })
  }, 15_000)

  it('serves /src/main.tsx and its kernel import as real ESM, with no CJS `exports` artifact anywhere in the module graph', async () => {
    let output = ''
    const proc = spawn(viteBin, ['--strictPort=false', '--logLevel', 'info'], {
      cwd: webDir,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = proc

    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`vite dev server did not print a Local URL within 20s. Output so far:\n${output}`))
      }, 20_000)

      proc.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const match = /Local:\s+(https?:\/\/(?:localhost|127\.0\.0\.1):\d+)\//.exec(output)
        if (match?.[1]) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
      proc.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      proc.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timer)
          reject(new Error(`vite dev exited early with code ${code}. Output:\n${output}`))
        }
      })
    })

    // 1. The document itself: HTTP 200, the right title, an empty mount
    // point and a module-script tag pointing at main.tsx — exactly what
    // the diagnosed defect described ("serves, returns HTTP 200, sets the
    // right document title, and paints nothing"). This assertion alone
    // would NOT have caught the regression; it establishes the starting
    // state the rest of the test builds on.
    const indexRes = await fetch(`${baseUrl}/`)
    expect(indexRes.status).toBe(200)
    const indexHtml = await indexRes.text()
    expect(indexHtml).toContain('<title>GaDongHR</title>')
    expect(indexHtml).toContain('src="/src/main.tsx"')

    // 2. The entry module must transform and serve without error.
    const mainRes = await fetch(`${baseUrl}/src/main.tsx`)
    expect(mainRes.status).toBe(200)
    const mainSrc = await mainRes.text()
    expect(mainSrc).not.toContain('Object.defineProperty(exports')
    expect(mainSrc).toContain('createRoot')

    // 3. The three files named in the bug report must each transform and
    // serve without error, AND — this is the part a naive version of this
    // test got wrong during development — the kernel import each of them
    // resolves to (Vite rewrites the bare `@gadong/kernel/dist/i18n/format`
    // specifier to a concrete served URL, e.g.
    // `/@fs/.../packages/kernel/dist/i18n/format.js` when unfixed, or
    // `/@fs/.../packages/kernel/src/i18n/format.ts` once aliased) must
    // ALSO be followed and fetched. Asserting only on the importer file's
    // own transformed text is not enough: `Money.tsx`'s own source never
    // literally contains `Object.defineProperty(exports` regardless of
    // whether the import it resolves to is broken — that string only
    // appears in the resolved kernel module itself. A first draft of this
    // test skipped that follow-through and passed even with the bug
    // reproduced (`git stash` on `vite.config.ts` + rerun confirmed it).
    const importerPaths = ['/src/components/Money.tsx', '/src/components/DateText.tsx', '/src/i18n/locale.ts']
    // `locale.ts` imports only the `Locale` *type* (`import type { Locale }
    // from ...`), which esbuild erases entirely at transform time — there
    // is no runtime specifier left to follow in its output, only the
    // guarantee that it transforms cleanly. `Money.tsx`/`DateText.tsx`
    // import runtime values (`formatTHB`/`formatDate`) and DO retain a
    // resolvable `from "..."` specifier.
    const resolvedKernelSpecifiers = new Set<string>()
    for (const path of importerPaths) {
      const res = await fetch(`${baseUrl}${path}`)
      expect(res.status).toBe(200)
      const src = await res.text()
      expect(src).not.toContain('Object.defineProperty(exports')
      expect(src).not.toContain('"use strict"')

      const importMatch = /from\s+"([^"]*i18n\/format[^"]*)"/.exec(src)
      if (importMatch?.[1]) {
        resolvedKernelSpecifiers.add(importMatch[1])
      }
    }

    // Every importer must agree on the same resolved module — a diverging
    // resolution across files would itself be a bug.
    expect(resolvedKernelSpecifiers.size).toBe(1)
    const [resolvedSpecifier] = resolvedKernelSpecifiers
    if (!resolvedSpecifier) {
      throw new Error('no resolved kernel-format specifier was captured')
    }

    // 4. Fetch the ACTUAL module every importer resolves to (not an
    // assumed path) and prove it is real ESM, not the CommonJS `dist`
    // build the bug report diagnosed: no `"use strict"` prologue, no
    // `Object.defineProperty(exports, ...)`, and it exports the functions
    // `web` needs via genuine `export` statements.
    const formatRes = await fetch(`${baseUrl}${resolvedSpecifier}`)
    expect(formatRes.status).toBe(200)
    const formatSrc = await formatRes.text()
    expect(formatSrc).not.toContain('Object.defineProperty(exports')
    expect(formatSrc).not.toContain('"use strict"')
    expect(formatSrc).toMatch(/export\s+function\s+formatDate/)
    expect(formatSrc).toMatch(/export\s+function\s+formatTHB/)

    // And, precisely: it must be the TypeScript source, not the compiled
    // CommonJS `dist` output, confirming the alias in `vite.config.ts` is
    // what's doing the work (not some other accidental fix).
    expect(resolvedSpecifier).toContain('/packages/kernel/src/i18n/format.ts')
    expect(resolvedSpecifier).not.toContain('/packages/kernel/dist/')
  }, 30_000)
})
