// `@react-native-async-storage/async-storage` ships its own in-memory jest
// mock (not part of jest-expo's own RN-core mocks, since it's a separate
// community package) — every test that touches `lib/i18n/locale.ts`
// (directly, or via `I18nProvider`) needs this wired up, so it lives here
// once rather than per test file.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock's factory runs before ESM imports are linked; the official async-storage mock is documented as a require() here.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
