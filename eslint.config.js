const js = require('@eslint/js')
const ts = require('typescript-eslint')

module.exports = [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
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
]
