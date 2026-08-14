/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/scripts/'],
  // Deliberately NOT overriding `transformIgnorePatterns` — `jest-expo`'s
  // preset already ships one wide enough to transform the RN/Expo
  // ecosystem's own ESM-syntax node_modules (`@react-native/js-polyfills`
  // etc.); replacing it wholesale here (an earlier version of this file
  // did) shadows that default and breaks jest-preset's own setup file.
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}'],
};
