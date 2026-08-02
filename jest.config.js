module.exports = {
  testEnvironment: 'node',
  // `deploy` added by Task 13: `deploy/compose-validation.test.ts` is the
  // test suite for the compose files themselves (this task's deliverable
  // is configuration, not application code — see that file's header).
  roots: ['<rootDir>/packages', '<rootDir>/services', '<rootDir>/deploy'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['packages/**/src/**/*.ts', 'services/**/src/**/*.ts'],
  // `preset: 'ts-jest'` (the previous config) transforms with an empty ts-jest
  // options object, which makes ts-jest resolve its tsconfig by searching
  // upward from the jest rootDir (the repo root) — finding the root solution
  // tsconfig.json immediately, which declares no `compilerOptions` at all.
  // Measured (fix round 1 review correction — an earlier version of this
  // comment wrongly said "ES3-era defaults"): that resolves to target
  // ES2015, `strict` off, and `experimentalDecorators` off. The ES2015
  // target alone was enough to reject any BigInt literal (`100n`) anywhere
  // in the test suite ("BigInt literals are not available when targeting
  // lower than ES2020"), which is incompatible with the house rule that
  // money is bigint satang, never a float. Pointing ts-jest at
  // tsconfig.base.json (the same ES2023/strict/noUncheckedIndexedAccess
  // settings every package tsconfig extends) fixes that, and — the larger,
  // previously-unstated gain — means every *.test.ts file in the repo is
  // now type-checked under `strict` + `noUncheckedIndexedAccess` for the
  // first time, not just under whatever loose defaults let it merely parse.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.base.json' }],
  },
}
