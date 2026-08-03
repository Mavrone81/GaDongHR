/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Config from env, not hardcoded (task brief): every VITE_* var below is
// read at runtime from import.meta.env, populated by Vite from `.env.local`
// (dev) or the build-time environment (staging/prod) — see env.ts and
// README.md. Nothing here hardcodes a host or port.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
      'ui-coverage.test.ts',
    ],
  },
})
