import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { run, waitFor, httpGetOk } from './lib/exec'
import { provisionVaultForCrypto } from './lib/vault'
import { signPack } from './lib/pack-signing'
import type { PackRecord } from './lib/pack-signing'
import { grantPermission, grantRole, seedOnboardingOrgAndPosition, waitForRoleSeeded } from './lib/db'

const E2E_DIR = join(__dirname)
const COMPOSE_FILE = join(E2E_DIR, 'docker-compose.yml')
const RUNTIME_DIR = join(E2E_DIR, 'runtime')
const CONFIG_PACK_SIGNING_KEY = 'e2e-config-pack-signing-key'
const OIDC_ISSUER_URL = 'http://127.0.0.1:18081'

export const PORTS = {
  authz: 18001,
  config: 18002,
  crypto: 18003,
  onboarding: 18004,
  scheduler: 18005,
  attendance: 18006,
  timesheet: 18007,
  payroll: 18008,
  docs: 18009,
}

/** Fixed, deterministic subs for every persona this lifecycle needs — real users have real UUIDs; these just don't change between runs. */
export const PERSONAS = {
  seeder: '00000000-0000-4000-8000-0000e2e00001',
  hrOfficer: '00000000-0000-4000-8000-0000e2e00002',
  manager: '00000000-0000-4000-8000-0000e2e00003',
  employee: '00000000-0000-4000-8000-0000e2e00004',
  payrollPreparer: '00000000-0000-4000-8000-0000e2e00005',
  payrollApprover: '00000000-0000-4000-8000-0000e2e00006',
  /** Holds `timesheet.totals.read` ONLY — the machine-only permission `GET /periods/:id/totals` is gated by (see timesheet.controller.ts's doc). Stands in for the client-credentials identity `svc-payroll` does not yet have in this deployment (see e2e-lifecycle.md's seam-defects list) — proves the ROUTE itself is correct for an authorized machine caller, distinct from proving `svc-payroll`'s own unauthenticated ports.ts client can reach it (it cannot, by design; asserted separately). */
  payrollMachine: '00000000-0000-4000-8000-0000e2e00007',
  noPermissions: '00000000-0000-4000-8000-0000e2e00099',
}

async function compose(...args: string[]): Promise<string> {
  return run('docker', ['compose', '-f', COMPOSE_FILE, ...args], { env: { VAULT_APPROLE_ID: process.env['VAULT_APPROLE_ID'] ?? 'unset' } })
}

export async function mintToken(sub: string, claims: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${OIDC_ISSUER_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub, claims }),
  })
  if (!res.ok) throw new Error(`mintToken(${sub}) -> ${String(res.status)}`)
  const body = (await res.json()) as { access_token: string }
  return body.access_token
}

async function waitForHealthy(name: string, url: string): Promise<void> {
  // 600s, not 240s: this host runs several other unrelated docker-compose
  // projects concurrently (observed: 20+ containers outside this stack),
  // and under that contention a service that boots in ~10s in isolation
  // has been observed taking several minutes for its /health to answer.
  // Widening the budget costs nothing on a quiet CI runner and is what
  // keeps this a genuine health wait rather than a race against this one
  // shared host's noisy-neighbour load.
  await waitFor(name, () => httpGetOk(url), 600_000, 2000)
}

/**
 * `svc-crypto`'s own `/health` (`buildHealth`, `packages/kernel/src/health.ts`)
 * deliberately answers HTTP 200 with `status: "degraded"` rather than a
 * non-2xx status when Vault is unreachable/sealed — the doc comment there
 * explains why (a sealed Vault after a host reboot must not look like a
 * crashed container). That is the right contract for a Docker healthcheck
 * or a load balancer, but it means `waitForHealthy`'s `httpGetOk` (which
 * only checks `res.ok`, i.e. 200-299) treats "process is up, Vault
 * unreachable" as ready.
 *
 * Worse, `vault.client.ts`'s own `health()` calls only Vault's unauthenticated
 * `sys/health` (sealed check) — it never exercises the AppRole login or a
 * transit call, so even a `dependencies: { vault: "up" }` body does not
 * prove `POST /encrypt` will succeed. The only way to know svc-crypto can
 * actually do its one job — reach Vault, log in via AppRole, and drive the
 * transit engine — is to make it do that job for real: a genuine
 * encrypt-then-decrypt round trip through its real HTTP API, byte for byte.
 * A CI run that raced this gap failed every downstream lifecycle step with
 * `CRY-503`, immediately after `/health` had reported 200 — see
 * `.superpowers/sdd/02-modules/ci-gates-fix.md`.
 */
async function waitForCryptoReady(): Promise<void> {
  const base = `http://127.0.0.1:${String(PORTS.crypto)}`
  const entityId = 'e2e-harness-crypto-readiness-probe'
  const field = 'probe'
  const plaintext = 'e2e-crypto-round-trip-ok'

  await waitFor(
    'svc-crypto real encrypt/decrypt round-trip (proves AppRole login + transit, not just /health — see harness.ts comment)',
    async () => {
      const encRes = await fetch(`${base}/encrypt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: [{ entityId, field, value: plaintext, fieldClass: 'S2' }] }),
      })
      if (!encRes.ok) return false
      const encBody = (await encRes.json()) as { fields?: Record<string, string> }
      const ciphertext = encBody.fields?.[field]
      if (typeof ciphertext !== 'string') return false

      const decRes = await fetch(`${base}/decrypt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entityId, field, ciphertext, purpose: 'e2e-harness-readiness-probe' }),
      })
      if (!decRes.ok) return false
      const decBody = (await decRes.json()) as { value?: string }
      return decBody.value === plaintext
    },
    120_000,
    2000,
  )
}

export async function up(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true })

  console.log('[harness] phase 1: postgres, vault, minio, rabbitmq, oidc-issuer')
  await compose('up', '-d', '--build', 'postgres', 'vault', 'minio', 'rabbitmq', 'oidc-issuer')
  await waitForHealthy('vault', `${'http://127.0.0.1:18200'}/v1/sys/health?standbyok=true`)
  await waitForHealthy('oidc-issuer', `${OIDC_ISSUER_URL}/health`)
  await waitFor('postgres', async () => {
    try {
      await run('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'gadonghr_super', '-d', 'gadonghr'])
      return true
    } catch {
      return false
    }
  })

  console.log('[harness] provisioning vault transit + approle for svc-crypto')
  const creds = await provisionVaultForCrypto()
  writeFileSync(join(RUNTIME_DIR, 'vault_approle_secret'), creds.secretId, 'utf8')
  chmodSync(join(RUNTIME_DIR, 'vault_approle_secret'), 0o644)
  process.env['VAULT_APPROLE_ID'] = creds.roleId

  console.log('[harness] ensuring minio bucket exists')
  await run('docker', [
    'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'minio', 'sh', '-c',
    'mc alias set local http://127.0.0.1:9000 e2e-minio-user e2e-minio-password >/dev/null 2>&1; mc mb --ignore-existing local/gadonghr-docs-e2e',
  ])

  // Phase 2, SEQUENTIAL — a real seam defect found this session, not
  // sandbox noise: `node-pg-migrate` guards a migration run with
  // `pg_try_advisory_lock(PG_MIGRATE_LOCK_ID)` where `PG_MIGRATE_LOCK_ID`
  // is a single hardcoded constant
  // (`node_modules/node-pg-migrate/dist/runner.js`), and `pg_advisory_lock`
  // is scoped to the whole Postgres DATABASE, not to a schema. Every
  // GaDongHR service migrates its own schema but the SAME shared database
  // (`deploy/docker-compose.yml`'s single `${POSTGRES_DB}` — this harness's
  // `gadonghr` is the identical topology), so when two or more services
  // boot at once, all racing `pg_try_advisory_lock`, one gets
  // `lockObtained: false` and node-pg-migrate throws immediately —
  // `"Another migration is already running"` — with NO retry, taking the
  // whole container down (`main.ts`'s `bootstrap().catch(() =>
  // process.exit(1))`). This was misdiagnosed at first as host resource
  // contention (a plausible read of "one of nine containers intermittently
  // dies") until the actual crash log was captured: a THIRD service
  // (svc-onboarding), started as part of only a four-service batch,
  // produced the exact "Another migration is already running" trace,
  // which is a deterministic lock race, not a timing fluke. This is a
  // real production defect: `docker compose up -d` for a fresh GaDongHR
  // deployment (or any restart that migrates more than one service at
  // once — e.g. a version bump touching two services' migrations) can
  // crash-loop any service that loses this race, forever, since nothing
  // retries it — see the e2e report's seam-defects list.
  //
  // The fix here is deliberately the dumbest possible one: migrate one
  // service at a time, waited to `/health` (which only reports once its
  // own migration + boot has completed) before starting the next. Slower,
  // but removes the race entirely without touching any service's own
  // code — the real fix (retry-with-backoff around `runner()` in every
  // service's `main.ts`, or serializing migrations behind a
  // deployment-level lock) is out of this session's scope and is reported,
  // not silently patched around in application code.
  console.log('[harness] phase 2: application services, ONE AT A TIME (node-pg-migrate advisory-lock race — see harness.ts comment)')
  const appServices = ['svc-authz', 'svc-config', 'svc-crypto', 'svc-onboarding', 'svc-scheduler', 'svc-attendance', 'svc-timesheet', 'svc-docs', 'svc-payroll']

  // Build every image ONCE, up front, separately from `up` — a second real
  // seam defect found this session, distinct from the migration race above.
  // `docker compose up -d --build <one-service>` still resolves and BUILDS
  // every service in that one service's `depends_on` closure, not just the
  // named one (BuildKit's bake driver builds the whole plan the compose
  // file's dependency graph implies). With buildx provenance attestation on
  // by default, even a 100%-cache-hit rebuild produces a NEW image digest
  // for every one of those dependencies — so each later iteration of this
  // loop silently rebuilt (and Compose then RECREATED) every earlier
  // service still listed in the new target's `depends_on`. Concretely: the
  // last iteration (`svc-payroll`, whose `depends_on` includes svc-authz
  // and svc-crypto) rebuilt+recreated the ALREADY-HEALTHY svc-authz and
  // svc-crypto containers right as this loop finished — losing their
  // in-memory Vault AppRole token cache and racing the lifecycle suite's
  // very first HTTP call against a container that had just restarted and
  // not yet finished booting. That is a genuine, confirmed defect this
  // session found (reproduced with `docker ps` uptimes resetting mid-loop
  // and Compose's own "Recreate"/"Recreated" log lines) — NOT, it turned
  // out, the reason the lifecycle suite's first HTTP call still fails
  // after this fix: that remaining `CRY-503` is a separate, real product
  // defect (a wrong ciphertext-length constant in
  // `packages/kernel/src/crypto/client.ts`), reported in full in
  // `.superpowers/sdd/02-modules/ci-gates-fix.md` rather than patched here
  // — see that doc before assuming this fix alone turns `e2e` green.
  // Building every image before ANY `up` call removes the repeated-rebuild
  // trigger entirely: once built, plain `up -d` (no `--build`) starts a
  // container from the image that already exists and never recreates a
  // container whose image hasn't changed.
  await compose('build', ...appServices)

  for (const name of appServices) {
    await compose('up', '-d', name)
    await waitForHealthy(name, `http://127.0.0.1:${String(PORTS[name.replace('svc-', '') as keyof typeof PORTS])}/health`)
    // svc-crypto's /health passing is necessary but not sufficient (see
    // waitForCryptoReady's doc comment) — every later service in this loop
    // (onboarding, attendance, docs, payroll) calls svc-crypto for real, so
    // this must be proven before any of them boot, not just before the
    // test suite starts.
    if (name === 'svc-crypto') await waitForCryptoReady()
  }

  console.log('[harness] waiting for svc-authz role catalog to self-seed')
  await waitFor('authz role catalog', () => waitForRoleSeeded('hr-system-admin'), 60_000, 2000)

  console.log('[harness] granting personas their roles (direct SQL, mirrors deploy/scripts/seed.sh\'s seeder-bootstrap pattern)')
  await grantRole(PERSONAS.seeder, 'hr-system-admin', PERSONAS.seeder)
  await grantRole(PERSONAS.hrOfficer, 'hr-officer', PERSONAS.seeder)
  await grantRole(PERSONAS.manager, 'line-manager', PERSONAS.seeder)
  await grantRole(PERSONAS.employee, 'employee-ess', PERSONAS.seeder)
  await grantRole(PERSONAS.payrollPreparer, 'payroll-officer', PERSONAS.seeder)
  await grantRole(PERSONAS.payrollApprover, 'payroll-approver', PERSONAS.seeder)
  await grantPermission(PERSONAS.payrollMachine, 'timesheet.totals.read', PERSONAS.seeder)

  console.log('[harness] seeding the org unit + position the lifecycle test hires into (onboarding.employee has real FKs into both; nothing in svc-onboarding\'s own HTTP API creates either, so this is test-data setup, not a shortcut)')
  await seedOnboardingOrgAndPosition('00000000-0000-4000-8000-0000000ac001', '00000000-0000-4000-8000-0000000ac002')

  console.log('[harness] importing statutory rule packs (the real, shipped services/svc-config/seed/*.json — the same two files deploy/scripts/seed.sh imports; no separate e2e-only fixture — see e2e-lifecycle.md for the TH-STATUTORY-v1.json unit-encoding/missing-key fixes this task made to the real pack)')
  await importPack(join(E2E_DIR, '..', '..', 'services', 'svc-config', 'seed', 'TH-STATUTORY-v1.json'))
  await importPack(join(E2E_DIR, '..', '..', 'services', 'svc-config', 'seed', 'TH-HOLIDAYS-2026.json'))

  console.log('[harness] stack up')
}

async function importPack(filePath: string): Promise<void> {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { pack_id: string; version: number; records: PackRecord[] }
  const signed = signPack(raw, CONFIG_PACK_SIGNING_KEY)
  const token = await mintToken(PERSONAS.seeder)
  const res = await fetch(`http://127.0.0.1:${String(PORTS.config)}/packs/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(signed),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`importPack(${raw.pack_id}) -> ${String(res.status)}: ${body}`)
  console.log(`[harness] imported pack ${raw.pack_id}: ${body}`)
}

export async function down(): Promise<void> {
  console.log('[harness] tearing down')
  try {
    await compose('down', '-v', '--remove-orphans')
  } catch (err) {
    console.error('[harness] teardown error (continuing):', err)
  }
}
