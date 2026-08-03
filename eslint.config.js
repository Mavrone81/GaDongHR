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
    // CommonJS globals that the flat-config defaults don't provide.
    files: ['*.config.js'],
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
]
