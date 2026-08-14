import { execFileSync, spawnSync } from 'node:child_process'
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
const SCRIPTS = ['seed.sh', 'bootstrap-admin.sh', 'vault-ceremony.sh', 'vault-verify-ceremony.sh']

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

/**
 * Two verified defects (deploy-truth task): (1) the script defaulted to
 * paths that don't exist on gadonghr-prod (`/opt/gadonghr`, real repo is
 * `/root/GaDongHR`) and hardcoded `origin/main` even though production
 * tracks `phase-1-platform-services` — so it had never once run for real,
 * every deploy to date was manual; (2) unrelated to this script directly,
 * but the `refs/ci-pass/<sha>` gate this script depends on is the entire
 * safety story for defect (1)'s fix (a configurable branch is worthless
 * if the gate it feeds into can be bypassed), so both are asserted here
 * together, straight from the script's own source — not a copy that could
 * drift from it.
 */
describe('deploy/scripts/auto-deploy-gadonghr.sh — branch configurability and the ci-pass gate', () => {
  const contents = readFileSync(join(SCRIPTS_DIR, 'auto-deploy-gadonghr.sh'), 'utf8')

  test('is syntactically valid bash (`bash -n`)', () => {
    expect(() =>
      execFileSync('bash', ['-n', join(SCRIPTS_DIR, 'auto-deploy-gadonghr.sh')], { stdio: 'pipe' }),
    ).not.toThrow()
  })

  test('the tracked branch is configurable via GADONG_DEPLOY_BRANCH, not hardcoded', () => {
    expect(contents).toMatch(/GADONG_DEPLOY_BRANCH="\$\{GADONG_DEPLOY_BRANCH:-\w+\}"/)
  })

  test('resolves the remote sha from the configured branch, never a hardcoded `origin/main`', () => {
    expect(contents).toContain('git rev-parse "origin/${GADONG_DEPLOY_BRANCH}"')
    // Negative check: no literal `origin/main` anywhere outside the
    // Configuration block's own fallback default (which is a bare `main`
    // string, not `origin/main`) — the whole point of the fix is that the
    // branch is never spelled out at the call site.
    expect(contents).not.toMatch(/git rev-parse origin\/main\b/)
    expect(contents).not.toMatch(/git rev-parse "origin\/main"/)
  })

  test('REPO_DIR/DEPLOY_DIR/STATE_FILE default to the real gadonghr-prod paths, all overridable', () => {
    expect(contents).toMatch(/REPO_DIR="\$\{GADONG_REPO_DIR:-\/root\/GaDongHR\}"/)
    // DEPLOY_DIR and STATE_FILE derive from REPO_DIR (not a second,
    // independently-hardcoded path) so a `GADONG_REPO_DIR` override moves
    // both with it — the same class of drift that caused defect (1).
    expect(contents).toMatch(/DEPLOY_DIR="\$\{GADONG_DEPLOY_DIR:-\$REPO_DIR\/deploy\}"/)
    expect(contents).toMatch(/STATE_FILE="\$\{GADONG_DEPLOY_STATE:-\$REPO_DIR\/\.last-deployed-sha\}"/)
    expect(contents).not.toContain('/opt/gadonghr')
  })

  test('the refs/ci-pass/<sha> gate is still load-bearing: no-ops (exit 0, no checkout) when the marker is missing', () => {
    const gateIdx = contents.indexOf('refs/ci-pass/')
    const checkoutIdx = contents.indexOf('git checkout --quiet')
    const exitZeroIdx = contents.indexOf('exit 0', gateIdx)
    expect(gateIdx).toBeGreaterThan(-1)
    expect(checkoutIdx).toBeGreaterThan(-1)
    // The no-op `exit 0` for a missing marker must appear, in source
    // order, before the checkout that would move the working tree onto
    // an unverified commit.
    expect(exitZeroIdx).toBeGreaterThan(gateIdx)
    expect(exitZeroIdx).toBeLessThan(checkoutIdx)
    expect(contents).toMatch(/ls-remote --exit-code origin "refs\/ci-pass\/\$\{remote_sha\}"/)
  })

  // Executable lines only — comments legitimately mention the forbidden
  // shapes (e.g. "NEVER `docker compose build` here") as documentation of
  // the constraint, which would otherwise false-positive a naive search.
  const codeLines = contents
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

  test('GADONG_VERSION is exported from the CI-verified remote_sha, never GADONG_BUILD_SHA, before pulling', () => {
    const exportIdx = codeLines.indexOf('export GADONG_VERSION="$remote_sha"')
    const pullIdx = codeLines.indexOf('compose pull')
    expect(exportIdx).toBeGreaterThan(-1)
    expect(pullIdx).toBeGreaterThan(exportIdx)
    expect(codeLines).not.toMatch(/export GADONG_BUILD_SHA/)
  })

  test('never runs `docker compose build` or `down -v` or `system prune --volumes` (roadmap standing constraints)', () => {
    expect(codeLines).not.toMatch(/compose\s+build\b/)
    expect(codeLines).not.toMatch(/down\s+-v\b/)
    expect(codeLines).not.toMatch(/system prune[^\n]*--volumes/)
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

/**
 * Task 16g: the production Vault key ceremony. Same "the tests ARE the
 * proof" shape as the rest of this file — this environment has no Vault
 * to rekey against (and the brief explicitly forbids running this
 * against the live droplet), so what's provable mechanically is proven:
 * syntax, the confirmation gate actually gates (verified by really
 * invoking the script and watching it refuse — this is 100% safe, the
 * confirmation check is the FIRST thing the script does, before any
 * docker/vault/jq call), and that no code path anywhere writes or
 * derives a plaintext share.
 */
describe('deploy/scripts/vault-ceremony.sh — the PGP-encryption guarantee', () => {
  const contents = readFileSync(join(SCRIPTS_DIR, 'vault-ceremony.sh'), 'utf8')

  test('always rekeys via -pgp-keys, never a plain (unencrypted) rekey', () => {
    expect(contents).toMatch(/-pgp-keys=/)
  })

  test('extracts only the PGP-encrypted share field (keys_base64), never the bare hex field', () => {
    expect(contents).toContain('keys_base64')
    // ".keys[" (bare, not "keys_base64[") would mean touching Vault's
    // hex-encoded field directly rather than going through the
    // encrypted variant — this script must never do that.
    expect(contents).not.toContain('.keys[')
  })

  test('submits the current unseal key over stdin, never as a CLI/exec argument', () => {
    expect(contents).toMatch(/printf '%s\\n' "\$VAULT_UNSEAL_KEY" \|/)
    // Negative check: the unseal key variable must never appear as a
    // trailing positional argument to a `vault operator rekey` call —
    // that would put it in the container's process list.
    expect(contents).not.toMatch(/vault operator rekey[^\n]*\$VAULT_UNSEAL_KEY/)
  })

  test('has a safety scan that aborts, unencrypted-looking output is never written to disk', () => {
    expect(contents).toMatch(/ABORTING before writing any file/)
    expect(contents).toMatch(/too short to be a PGP-encrypted envelope/)
  })

  test('never uses `set -x` (would risk echoing the unseal key to logs)', () => {
    expect(contents).not.toMatch(/^\s*set\s+-\w*x\w*/m)
  })

  test('writes each officer share file at mode 400', () => {
    expect(contents).toContain('chmod 400')
  })

  test('removes VAULT_UNSEAL_KEY and VAULT_ROOT_TOKEN from .env, never assigns them a literal', () => {
    expect(contents).toMatch(/VAULT_UNSEAL_KEY=/)
    expect(contents).toMatch(/VAULT_ROOT_TOKEN=/)
    // Both must be read via the `${VAR:?...}` required-env-var idiom,
    // matching every other script in this directory.
    expect(contents).toContain('${VAULT_UNSEAL_KEY:?')
    expect(contents).toContain('${VAULT_ROOT_TOKEN:?')
  })

  test('never deletes the -backup copy or revokes the root token itself (both gated on officer confirmation, printed as manual steps)', () => {
    // Both commands appear ONLY inside the final `cat <<EOF ... EOF`
    // summary block (printed text for a human to run later) — never as
    // an actually-executed line elsewhere in the script.
    const heredocStart = contents.indexOf('cat <<EOF')
    const heredocEnd = contents.indexOf('\nEOF', heredocStart)
    expect(heredocStart).toBeGreaterThan(-1)
    expect(heredocEnd).toBeGreaterThan(heredocStart)

    const before = contents.slice(0, heredocStart)
    const inside = contents.slice(heredocStart, heredocEnd)
    const after = contents.slice(heredocEnd)

    for (const needle of ['-backup-delete', 'token revoke -self']) {
      expect(before).not.toContain(needle)
      expect(after).not.toContain(needle)
      expect(inside).toContain(needle) // present in the PRINTED instructions
    }
  })

  test('states the loss-of-3-shares consequence in the words an operator will read', () => {
    expect(contents).toMatch(/permanent,?\s*\n?\s*irreversible loss/i)
    expect(contents).toMatch(/no vendor backdoor/i)
  })

  test('refuses to run without its confirmation argument (verified by actually invoking it — safe: this is the first check, before any docker/vault call)', () => {
    const result = spawnSync('bash', [join(SCRIPTS_DIR, 'vault-ceremony.sh')], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr + result.stdout).toMatch(/--confirm-five-officers-present/)
  })

  test('refuses an unrecognised argument the same way (still no docker/vault call reached)', () => {
    const result = spawnSync('bash', [join(SCRIPTS_DIR, 'vault-ceremony.sh'), '--yolo'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr + result.stdout).toMatch(/Unrecognised argument/)
  })

  test('the confirmation check happens before every precondition, not after', () => {
    const confirmIdx = contents.indexOf('"$CONFIRMED" != true')
    const dockerCheckIdx = contents.indexOf("for bin in docker jq")
    const vaultStatusIdx = contents.indexOf('vault status -format=json')
    expect(confirmIdx).toBeGreaterThan(-1)
    expect(confirmIdx).toBeLessThan(dockerCheckIdx)
    expect(confirmIdx).toBeLessThan(vaultStatusIdx)
  })
})

describe('deploy/scripts/vault-verify-ceremony.sh — read-only proof, not another ceremony', () => {
  const contents = readFileSync(join(SCRIPTS_DIR, 'vault-verify-ceremony.sh'), 'utf8')

  test('reports Total Shares and Threshold from vault status', () => {
    expect(contents).toContain('Total Shares')
    expect(contents).toContain('Threshold')
  })

  test('checks .env no longer contains either staging key', () => {
    expect(contents).toMatch(/VAULT_UNSEAL_KEY=/)
    expect(contents).toMatch(/VAULT_ROOT_TOKEN=/)
  })

  test('checks the -backup copy is gone', () => {
    expect(contents).toContain('-backup-retrieve')
  })

  test('never calls vault operator rekey -init, -cancel, or unseal — read-only only', () => {
    expect(contents).not.toMatch(/rekey\s+-init/)
    expect(contents).not.toMatch(/rekey\s+-cancel/)
    expect(contents).not.toMatch(/operator unseal/)
  })

  test('never writes to .env', () => {
    expect(contents).not.toMatch(/>\s*"?\$ENV_FILE"?/)
    expect(contents).not.toMatch(/>>\s*"?\$ENV_FILE"?/)
  })

  test('extracts only keys_base64/nonce presence when probing the backup, never a bare .keys field', () => {
    expect(contents).not.toContain('.keys[')
  })
})

describe('deploy/signoff/key-register.md — the Runbook §2 template', () => {
  const contents = readFileSync(join(SCRIPTS_DIR, '..', 'signoff', 'key-register.md'), 'utf8')

  test('has the required columns: officer name, role, contact, PGP fingerprint, share file, date issued, signature', () => {
    expect(contents).toMatch(/Officer Name/)
    expect(contents).toMatch(/Role/)
    expect(contents).toMatch(/Contact/)
    expect(contents).toMatch(/PGP Fingerprint/)
    expect(contents).toMatch(/Share File/)
    expect(contents).toMatch(/Date Issued/)
    expect(contents).toMatch(/Signature/)
  })

  test('has one template row per officer, for all 5 officers', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(contents).toMatch(new RegExp(`\\|\\s*${n}\\s*\\|`))
    }
  })

  test('states the standing rules: never on host, never chat/email, never two shares one person, quarterly re-attestation', () => {
    expect(contents).toMatch(/never.*host/i)
    expect(contents).toMatch(/never.*(chat|email)/i)
    expect(contents).toMatch(/no officer holds two shares/i)
    expect(contents).toMatch(/quarterly re-attestation/i)
  })

  test('states the loss-of-3-shares consequence and "no vendor backdoor" in plain words', () => {
    expect(contents).toMatch(/permanent,?\s*irreversible loss/i)
    expect(contents).toMatch(/no vendor backdoor/i)
  })

  test('never contains an actual key/share/token value (only template placeholders)', () => {
    expect(contents).not.toMatch(/BEGIN PGP (PUBLIC|PRIVATE) KEY BLOCK/)
    expect(contents).not.toMatch(/hvs\.[A-Za-z0-9]{20,}/) // shape of a real Vault token
  })
})

describe('docs/07-operations/OPERATIONS-RUNBOOK.md §2 — reflects the real ceremony', () => {
  const contents = readFileSync(
    join(SCRIPTS_DIR, '..', '..', 'docs', '07-operations', 'OPERATIONS-RUNBOOK.md'),
    'utf8',
  )

  test('references the real scripts, not a not-yet-built vault-init.sh', () => {
    expect(contents).toContain('vault-ceremony.sh')
    expect(contents).toContain('vault-verify-ceremony.sh')
  })

  test('documents the -pgp-keys mechanism and the -backup destroy-timing rule', () => {
    expect(contents).toMatch(/-pgp-keys/)
    expect(contents).toMatch(/only once every.*officer/i)
  })

  test('documents what happens to the root token', () => {
    expect(contents).toMatch(/token revoke -self/)
    expect(contents).toMatch(/generate-root/)
  })
})
