/**
 * `pnpm test:e2e` entrypoint. Brings up the real stack (`harness.ts`),
 * runs the real-HTTP lifecycle suite (`lifecycle.e2e.test.ts`, via Jest —
 * `jest.config.js`), and always tears the stack down afterward, regardless
 * of the suite's outcome. Exits with the suite's own exit code so CI can
 * gate on it once wired.
 *
 * No manual step: `docker`/`docker compose` are the only host
 * prerequisites (already true of `deploy/compose-validation.test.ts`,
 * which `pnpm test` already runs on every CI machine).
 */
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { up, down } from './harness'

const REPO_ROOT = join(__dirname, '..', '..')

async function main(): Promise<number> {
  await up()
  const result = spawnSync('npx', ['jest', '--config', 'test/e2e/jest.config.js', '--runInBand'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    console.error('[e2e] fatal error before/during the suite:', err)
    process.exitCode = 1
  })
  .finally(() => {
    if (process.env['E2E_KEEP_STACK'] === '1') {
      console.log('[e2e] E2E_KEEP_STACK=1 set, leaving containers up for inspection')
      return undefined
    }
    return down()
  })
