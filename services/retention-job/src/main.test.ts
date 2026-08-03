import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Asserts against `src/main.ts`'s own source text rather than importing and
 * running it. Importing it would execute `bootstrap()` at module load (its
 * final line is a bare `bootstrap().then(...).catch(...)` call, matching
 * every sibling service's `main.ts`), which needs a real `DATABASE_URL`
 * and a real Postgres to migrate against — neither exists in this
 * environment (Task 14 brief CONSTRAINTS: "no Postgres here"). Reading the
 * file as text, the same technique the migration test suites in this repo
 * use, proves the properties below without needing either.
 *
 * The single most important assertion in this file is the "no HTTP
 * listener" one: `retention-job` is the one component in this repo where
 * opening a port would be the bug, not the fix (Task 14 brief — it "serves
 * nothing"). Every other service's `src/main.ts` calls `app.listen(3000,
 * ...)`; this file documents, by failing loudly if that pattern is ever
 * copied in here, that the omission is deliberate.
 */

function mainSource(): string {
  return readFileSync(join(__dirname, 'main.ts'), 'utf8')
}

/**
 * Strips `/* ... *&#47;` block comments and `// ...` line comments so the
 * "no HTTP listener" assertions below check actual code shape, not prose.
 * Without this, the file's own doc-comment explaining *why* it must never
 * call `app.listen(...)` — which necessarily contains that literal string —
 * would trip its own regex and make the test meaningless (fails whether or
 * not the code is correct, only whether the comment exists).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('retention-job main.ts — opens no HTTP listener (the one service that must not)', () => {
  it('never calls .listen(...) in actual code (comments are stripped first)', () => {
    const code = stripComments(mainSource())
    expect(code).not.toMatch(/\.listen\s*\(/)
  })

  it('never imports NestFactory or any @nestjs/platform-express server bootstrap in actual code', () => {
    const code = stripComments(mainSource())
    expect(code).not.toMatch(/NestFactory/)
    expect(code).not.toMatch(/@nestjs\/platform-express/)
  })

  it('declares no /health route, string, or handler in actual code — there is nothing here for a compose healthcheck to poll', () => {
    const code = stripComments(mainSource())
    expect(code).not.toMatch(/\/health/)
  })

  it('says so in a comment, so a future contributor does not "fix" this as an oversight', () => {
    const source = mainSource()
    // Loose on wording, strict on intent: the file must explicitly discuss
    // not listening, not just happen to omit it.
    expect(source).toMatch(/no http listener/i)
  })

  it('the same "no .listen(...)" assertion FAILS against a mutated copy that adds a real listener call back into the code', () => {
    const code = stripComments(mainSource())
    const withListenerAdded = `${code}\napp.listen(3000, '0.0.0.0')\n`
    expect(withListenerAdded).not.toEqual(code)
    expect(withListenerAdded).toMatch(/\.listen\s*\(/)
  })
})

describe('retention-job main.ts — runs migrations against the retention schema before doing anything else', () => {
  it('imports node-pg-migrate\'s runner', () => {
    const source = mainSource()
    expect(source).toMatch(/from 'node-pg-migrate'/)
  })

  it('runs migrations with schema: \'retention\' and createSchema: true, mirroring services/svc-config/src/main.ts', () => {
    const source = mainSource()
    expect(source).toMatch(/schema:\s*'retention'/)
    expect(source).toMatch(/createSchema:\s*true/)
  })

  it('reads DATABASE_URL from the environment and fails loudly if it is missing, rather than silently no-op-ing', () => {
    const source = mainSource()
    expect(source).toMatch(/DATABASE_URL/)
    expect(source).toMatch(/throw new Error/)
  })

  it('the migration run happens before the (Phase 5) retention cycle runs — bootstrap awaits runMigrations() first', () => {
    const source = mainSource()
    const bootstrapMatch = /async function bootstrap\(\)[\s\S]*?\n\}/.exec(source)
    expect(bootstrapMatch).not.toBeNull()
    const body = bootstrapMatch?.[0] ?? ''
    const migrateIndex = body.indexOf('runMigrations')
    const cycleIndex = body.indexOf('runRetentionCycle')
    expect(migrateIndex).toBeGreaterThan(-1)
    expect(cycleIndex).toBeGreaterThan(-1)
    expect(migrateIndex).toBeLessThan(cycleIndex)
  })
})

describe('retention-job main.ts — does not implement Phase 5 business logic', () => {
  it('explicitly defers the scan/DPO-queue/crypto-erasure pipeline to Phase 5 rather than silently doing nothing', () => {
    const source = mainSource()
    expect(source).toMatch(/Phase 5/)
  })
})
