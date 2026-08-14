const js = require('@eslint/js')
const ts = require('typescript-eslint')

module.exports = [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      // `web`'s composite-project TS build output (tsc -b emits here so
      // `pnpm typecheck` can include web in the root project-reference
      // graph — see web/tsconfig.json's outDir) and its static `public/`
      // assets (a service worker with `self`/`caches` globals, a webmanifest,
      // fonts) are build artifacts / browser-served files, not source to
      // lint, exactly like `dist/` above.
      'web/.tsbuild/**',
      'web/public/**',
      // Expo's local dev-server cache (bundler cache, generated
      // `expo-env.d.ts`) — not source, and `mobile/.gitignore` already
      // keeps it out of version control, same treatment as `web/.tsbuild/**`.
      'mobile/.expo/**',
    ],
  },
  js.configs.recommended,
  // typescript-eslint v8's flat `recommended` preset ships its rules-only
  // block with no `files` restriction, so it applies to every linted file,
  // including the plain CommonJS *.config.js files below. Scope that block
  // (but not the plugin/parser registration block, which must stay global)
  // to TypeScript sources so the rules don't bleed into plain JS tooling.
  ...ts.configs.recommended.map((config) =>
    config.files || config.plugins ? config : { ...config, files: ['**/*.ts', '**/*.tsx'] },
  ),
  {
    // Root tooling configs (eslint.config.js, jest.config.js) are CommonJS,
    // evaluated by Node directly rather than bundled — they need the
    // CommonJS globals that the flat-config defaults don't provide. Same
    // treatment for mobile's own tooling configs (babel.config.js,
    // jest.config.js, metro.config.js) — Metro/Babel/Jest all load these
    // with Node's CommonJS `require`, never through Metro's own bundler.
    files: ['*.config.js', 'test/e2e/*.config.js', 'mobile/*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        exports: 'writable',
      },
    },
  },
  {
    rules: {
      // Statutory values must come from svc-config, never a literal in code.
      // This is a blunt instrument; the real gate is review, but it catches
      // the obvious cases in payroll and leave engines.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    // node-pg-migrate migration files are plain CommonJS `.js` (its own
    // runner loads them with `require`, matching each service's
    // package.json having no `"type": "module"`), so — like the root
    // `*.config.js` block above — they need CommonJS globals rather than
    // the flat-config ESM defaults. Scoped by path so it applies to every
    // service's `migrations/` directory (Task 7 onward), not just svc-config.
    files: ['services/*/migrations/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        exports: 'writable',
      },
    },
  },
  {
    // test/e2e/oidc-issuer/server.js — the zero-dependency JWKS/token issuer
    // the e2e harness runs in place of Keycloak (see docker-compose.yml's
    // header). Same CommonJS-globals need as the migration files above.
    files: ['test/e2e/oidc-issuer/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        exports: 'writable',
        console: 'readonly',
        Buffer: 'readonly',
        // S2S auth task: the client_credentials form-body parser
        // (`issueClientCredentialsToken`'s caller) uses the same global
        // `URLSearchParams` every browser/Node runtime provides — not a
        // new dependency, just a global this file didn't reference before.
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    // test/e2e/**/*.ts — the real-stack lifecycle harness (`pnpm test:e2e`).
    // Not part of the `tsc -b` project-reference graph (it is a standalone
    // ts-node script, not a workspace package), so it is linted but not
    // typechecked by `pnpm typecheck` — `pnpm test:e2e` itself typechecks it
    // via ts-node. `no-console` would fight this script's entire purpose
    // (a CLI harness that reports its own progress and the report's figures
    // to stdout).
    files: ['test/e2e/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
]
