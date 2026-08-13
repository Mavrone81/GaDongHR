// event-bus task: real-broker/real-Postgres proof, deliberately separate
// from `jest.config.js` (which every one of the other 2,587 tests runs
// under and which explicitly ignores `*.realbroker.test.ts` — see that
// file's comment). Requires `deploy/docker-compose.eventbus-test.yml`'s
// `postgres`/`rabbitmq` up and migrated — exact commands are in
// `.superpowers/sdd/02-modules/event-bus.md`. Run with `pnpm
// test:realbroker` (root `package.json`), a script added for this suite
// only — it does not replace or wrap the existing `test` script.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/packages', '<rootDir>/services'],
  testMatch: ['**/*.realbroker.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.base.json' }],
  },
  // A real broker connection plus real Postgres transactions run slower
  // than the in-memory fakes the rest of the suite uses.
  testTimeout: 30_000,
}
