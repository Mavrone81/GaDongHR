import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Task 15b: the deliverable here is two bash scripts, so — like
 * `deploy/compose-validation.test.ts` for the compose files and
 * `deploy/keycloak/realm-gadonghr.test.ts` for the realm import — this
 * file IS their test suite. No Keycloak/Postgres runs in this
 * environment, so what CAN be proven mechanically is proven: both scripts
 * are syntactically valid bash (`bash -n`), and neither embeds a real
 * secret (the task brief, verbatim: "Do not embed a secret in the
 * script; read it from the environment").
 */

const SCRIPTS_DIR = __dirname
const SCRIPTS = ['seed.sh', 'bootstrap-admin.sh']

/**
 * Deliberately broad, not just "=CHANGE_ME-shaped" — a script that reads
 * every credential via `${VAR:?...}`/`process.env.VAR` (as both scripts
 * here do) should never assign a literal value to anything that LOOKS
 * like a secret/password/token/key variable at all. Matches `VAR=literal`
 * (bash) and `VAR: 'literal'`/`VAR: "literal"` (the embedded JS heredocs)
 * where `literal` is non-empty and is not itself a shell/JS expansion
 * (`$...`, `` ` ``) or empty string.
 */
const SECRET_VAR_NAME = /(SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE_KEY)/i
const HARDCODED_ASSIGNMENT = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*[:=]\s*['"]?([^\s'"$`{][^\n'"]*)['"]?\s*,?\s*$/gm

function assertNoHardcodedSecrets(scriptName: string, contents: string): void {
  for (const line of contents.split('\n')) {
    HARDCODED_ASSIGNMENT.lastIndex = 0
    const match = HARDCODED_ASSIGNMENT.exec(line)
    if (!match) continue
    const [, varName, value] = match
    if (!varName || !SECRET_VAR_NAME.test(varName)) continue
    if (!value || value.trim().length === 0) continue
    throw new Error(`${scriptName}: line looks like a hard-coded secret assignment: "${line.trim()}"`)
  }
}

describe.each(SCRIPTS)('deploy/scripts/%s', (scriptName) => {
  const scriptPath = join(SCRIPTS_DIR, scriptName)
  let contents: string

  beforeAll(() => {
    contents = readFileSync(scriptPath, 'utf8')
  })

  test('is syntactically valid bash (`bash -n`)', () => {
    expect(() => execFileSync('bash', ['-n', scriptPath], { stdio: 'pipe' })).not.toThrow()
  })

  test('reads secrets from the environment, never assigns one a literal value', () => {
    assertNoHardcodedSecrets(scriptName, contents)
  })

  test('every secret-shaped env var is read via `${VAR:?...}` or `process.env.VAR`, not invented locally', () => {
    for (const name of ['KC_ADMIN_PASSWORD', 'KEYCLOAK_SEEDER_CLIENT_SECRET']) {
      if (!contents.includes(name)) continue
      const readsFromEnv = contents.includes(`\${${name}:?`) || contents.includes(`process.env.${name}`)
      expect(readsFromEnv).toBe(true)
    }
  })
})

describe('deploy/scripts/bootstrap-admin.sh idempotency shape', () => {
  const contents = readFileSync(join(SCRIPTS_DIR, 'bootstrap-admin.sh'), 'utf8')

  test('checks for an existing Keycloak user before creating one', () => {
    expect(contents).toMatch(/findExistingAdmin/)
    expect(contents).toMatch(/already exists/i)
  })

  test('forces a password change and OTP enrolment on first login', () => {
    expect(contents).toContain('UPDATE_PASSWORD')
    expect(contents).toContain('CONFIGURE_TOTP')
    expect(contents).toContain('temporary: true')
  })
})

describe('deploy/scripts/seed.sh Keycloak wiring', () => {
  const contents = readFileSync(join(SCRIPTS_DIR, 'seed.sh'), 'utf8')

  test('obtains a client-credentials token from the seeder service account', () => {
    expect(contents).toContain('client_credentials')
    expect(contents).toContain("client_id: 'seeder'")
  })

  test('fails clearly when Keycloak is unreachable or credentials are wrong', () => {
    expect(contents).toMatch(/Keycloak is unreachable/)
    expect(contents).toMatch(/rejected the seeder client-credentials request/)
  })

  test('grants the seeder its two svc-authz permissions, not the broader hr-system-admin template', () => {
    expect(contents).toContain('config.pack.import')
    expect(contents).toContain('authz.role.grant')
    expect(contents).not.toContain("'hr-system-admin'")
  })
})
