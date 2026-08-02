module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/packages', '<rootDir>/services'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['packages/**/src/**/*.ts', 'services/**/src/**/*.ts'],
  // `preset: 'ts-jest'` (the previous config) transforms with an empty ts-jest
  // options object, which makes ts-jest resolve its tsconfig by searching
  // upward from the jest rootDir (the repo root) — finding the root solution
  // tsconfig.json immediately, which declares no `compilerOptions` at all and
  // so compiles under TypeScript's ES3-era defaults. That silently blocked
  // any BigInt literal (`100n`) anywhere in the test suite ("BigInt literals
  // are not available when targeting lower than ES2020"), which is
  // incompatible with the house rule that money is bigint satang, never a
  // float. Pointing ts-jest at tsconfig.base.json (target ES2023, the same
  // settings every package tsconfig extends) fixes this for every workspace
  // package, not just kernel.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.base.json' }],
  },
}
