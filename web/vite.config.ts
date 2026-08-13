/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Config from env, not hardcoded (task brief): every VITE_* var below is
// read at runtime from import.meta.env, populated by Vite from `.env.local`
// (dev) or the build-time environment (staging/prod) — see env.ts and
// README.md. Nothing here hardcodes a host or port.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      // `web` deliberately imports only this one deep path out of
      // `@gadong/kernel` (see `src/api/svcConfig.ts`'s header) to keep `pg`,
      // `jose` and `@nestjs/common` out of the browser bundle. The problem:
      // `@gadong/kernel/dist/i18n/format.js` is CommonJS —
      // `tsconfig.base.json` sets `module: "commonjs"` for the whole
      // monorepo, correct for the 15 Node services — and `vite dev` serves
      // that file to the browser verbatim ("Object.defineProperty(exports,
      // ...)"). `exports` is undefined in a browser ES module, so the
      // import throws, the module graph dies, and React never mounts —
      // with no console error, because the failure happens before any
      // listener attaches. `commonjsOptions` below fixes this for `vite
      // build`'s Rollup pipeline, but `vite dev` doesn't use Rollup, so
      // that option can't reach it.
      //
      // `packages/kernel/src/i18n/format.ts` has no imports of its own
      // (verified: it's a pure module), so aliasing straight to the
      // TypeScript source is safe — nothing server-only (pg, jose, Nest
      // decorators) can ride in behind it. This `resolve.alias` is a single
      // top-level config, not scoped with `apply: 'serve'`, so Vite applies
      // it identically to `vite dev` and `vite build` — the two paths
      // cannot diverge. This also resolves before Rollup's commonjs
      // interop plugin ever runs, which makes the `packages/kernel/dist`
      // entry in `commonjsOptions.include` below unreachable for this
      // particular import; it's left in place as defence-in-depth for any
      // future import that targets kernel's compiled output directly.
      '@gadong/kernel/dist/i18n/format': fileURLToPath(
        new URL('../packages/kernel/src/i18n/format.ts', import.meta.url),
      ),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // pnpm workspace packages (`@gadong/kernel`) reach node_modules as a
    // symlink to `../packages/kernel`. Rollup resolves that symlink to its
    // real path (outside any `node_modules/`) before deciding whether a
    // file needs CommonJS-to-ESM interop — the interop plugin's default
    // `node_modules/**` include filter then never matches
    // `@gadong/kernel/dist/i18n/format.js` (CommonJS — `tsconfig.base.json`'s
    // `module: "commonjs"`, unchanged by `web`, which does not own the
    // kernel), and a production `vite build` fails with "formatDate is not
    // exported by format.js" even though `vite dev`/Vitest's esbuild-based
    // transform tolerates it (flipping `resolve.preserveSymlinks` globally
    // "fixes" this but BREAKS pnpm's own symlink-based dependency
    // resolution for every other package — e.g. `react-router-dom` ->
    // `react-router` — so this targets only the one real path that needs
    // CJS interop instead). See `src/auth/devBypass.build.test.ts`, which
    // runs a real `vite build` and would have caught this.
    commonjsOptions: {
      include: [/node_modules/, /packages\/kernel\/dist/],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: true,
    restoreMocks: true,
    globals: false,
    // `.tsbuild/` is `tsc -b`'s composite-build output for the root
    // `pnpm typecheck` project-reference graph (web/tsconfig.json's
    // outDir) — it contains a compiled `.test.js` copy of every test file
    // here. `ui-coverage.test.ts` is this package's one Jest-only test
    // (root `pnpm test`'s `jest` half — see its own header), with no
    // `describe`/`it` imports because it relies on Jest's globals, which
    // this project deliberately does not enable (`globals: false` above).
    // Without these excludes, Vitest's default include glob picks up both
    // and either double-runs or fails them.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.tsbuild/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      // `web/e2e/**` is the real-BROWSER Playwright suite
      // (`playwright.config.ts`'s `testDir`) — deliberately separate from
      // this Vitest/jsdom suite (task brief: "keep them separate"), run
      // via `pnpm --filter @gadong/web test:ui`, never `vitest`. Its files
      // are named `*.spec.ts`, which is inside Vitest's own default
      // include glob, so without this exclude Vitest tries to load and run
      // them itself and fails immediately — Playwright's `test.describe`
      // refuses to run outside its own runner.
      'e2e/**',
      'ui-coverage.test.ts',
    ],
  },
})
