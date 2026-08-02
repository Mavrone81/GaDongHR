module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages', '<rootDir>/services'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['packages/**/src/**/*.ts', 'services/**/src/**/*.ts'],
}
