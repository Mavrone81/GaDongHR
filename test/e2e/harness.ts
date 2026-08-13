import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { run, waitFor, httpGetOk } from './lib/exec'
import { provisionVaultForCrypto } from './lib/vault'
import { signPack } from './lib/pack-signing'
import type { PackRecord } from './lib/pack-signing'
import { grantPermission, grantRole, waitForRoleSeeded } from './lib/db'

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
  await waitFor(name, () => httpGetOk(url), 240_000, 2000)
}

export async function up(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true })

  console.log('[harness] phase 1: postgres, vault, minio, oidc-issuer')
  await compose('up', '-d', '--build', 'postgres', 'vault', 'minio', 'oidc-issuer')
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

  console.log('[harness] phase 2: application services')
  await compose('up', '-d', '--build', 'svc-authz', 'svc-config', 'svc-crypto', 'svc-onboarding', 'svc-scheduler', 'svc-attendance', 'svc-timesheet', 'svc-docs', 'svc-payroll')

  for (const [name, port] of Object.entries(PORTS)) {
    await waitForHealthy(name, `http://127.0.0.1:${String(port)}/health`)
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
