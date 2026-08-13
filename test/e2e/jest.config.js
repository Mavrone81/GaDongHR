module.exports = {
  testEnvironment: 'node',
  rootDir: '../..',
  roots: ['<rootDir>/test/e2e'],
  testMatch: ['**/*.e2e.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.base.json' }],
  },
  testTimeout: 120_000,
}
