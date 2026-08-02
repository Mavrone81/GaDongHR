# Phase 1 — Foundation & Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Read `00-PROGRAM-ROADMAP.md` §"Contracts every phase depends on" before any task.** The event catalog, permission catalog, data classification, ciphertext layout, audit entry shape and error envelope defined there are binding on every task in this plan and are not repeated here.

**Goal:** Every shared pattern in GaDongHR — encrypt-before-write, deny-by-default RBAC, transactional outbox, hash-chained audit, effective-dated statutory rules, trilingual rendering — built once in `@gadong/kernel` and proven by seven working platform services, with all fifteen services present in the repo and the whole thing deployed to `hr.bevorasg.com` through CI.

**Architecture:** A pnpm monorepo. `@gadong/kernel` holds every cross-cutting concern so no service reimplements security. Services are NestJS, one Postgres schema each, communicating by RabbitMQ events for facts and REST for questions. GitHub Actions builds SHA-tagged images to GHCR; the server only pulls.

**Tech Stack:** Node 22 · TypeScript 5.6 strict · NestJS 10 · pnpm 9 · Jest 29 · node-pg-migrate 7 · pg 8 · PostgreSQL 16 · RabbitMQ 3.13 · Vault 1.17 (Transit) · Keycloak 26 · MinIO · Playwright (PDF) · Docker Compose v5 · GHCR.

## Global Constraints

Binding on every task. Values are exact.

- **Node 22**, TypeScript `strict: true` with `noUncheckedIndexedAccess`. No `any` in committed code without an inline justification comment.
- **No statutory value may be hard-coded.** Rates, thresholds, multipliers, brackets and day-counts resolve through `svc-config` by rule key and date. A literal `0.05` for the SSO rate is a defect.
- **Encrypt before write.** S2/S3 fields reach Postgres only as `bytea` ciphertext. Ciphertext = `wrappedDEK ‖ nonce ‖ ct ‖ tag`, AES-256-GCM, **AAD = `entity_id + ':' + field_name`**. Searchable S3 fields get `<field>_bidx bytea` = `HMAC-SHA256(k_class, normalise(plaintext))`, where `normalise` = NFKC + trim + lowercase.
- **Fail closed.** Crypto unavailable ⇒ HTTP 503 with code `CRY-503`. Never a plaintext write, never a silent skip.
- **Deny by default.** Every HTTP route declares exactly one permission from the roadmap's catalog via `@RequirePermission()`. A route without one must fail a unit test.
- **`biometric.template.read` belongs to no human role.** Asserted globally.
- **Every service owns one schema** and its DB role is granted only that schema. No cross-schema query, no cross-schema foreign key.
- **Every state change writes to `outbox` in the same transaction.** Every consumer dedupes on `processed_events`.
- **Every S3 field read emits an audit entry carrying a mandatory `purpose`.**
- **Error envelope:** `{code, message_i18n_key, details[]}`. Codes use the roadmap's service prefixes.
- **No hard-coded user-visible strings.** i18n keys only, namespaced per module.
- **Dates:** stored ISO-8601 Gregorian UTC. B.E. is a rendering concern only.
- **Images build only in CI**, tagged `ghcr.io/mavrone81/gadonghr-<service>:<sha>` and `:main`.
- **Commits:** conventional (`feat(kernel):`, `fix(svc-crypto):`, `ci:`, `chore:`).
- **Every task ends green:** `pnpm typecheck && pnpm lint && pnpm test` all pass before the commit.

---

## File Structure

```
package.json  pnpm-workspace.yaml  tsconfig.base.json  jest.config.js  eslint.config.js
.github/workflows/ci.yml

packages/kernel/src/
  index.ts                 barrel — the only import surface for services
  version.ts               build stamp
  health.ts                shared health payload
  effective-date.ts        effective-dated record resolution
  errors.ts                GadongError + the standard envelope
  crypto/client.ts         CryptoClient — encrypt/decrypt/bidx via svc-crypto
  crypto/types.ts          FieldClass, EncryptedField
  outbox/outbox.ts         transactional write
  outbox/relay.ts          publish loop with metrics
  outbox/consumer.ts       idempotent consumer wrapper
  authz/guard.ts           NestJS guard + @RequirePermission decorator
  authz/client.ts          svc-authz decision API client, cached
  audit/emitter.ts         audit.* event emitter with purpose routing
  i18n/format.ts           B.E. dates, THB money, locale helpers
  db/pool.ts               per-service pool with statement timeout
  db/migrate.ts            node-pg-migrate runner invoked at boot

services/svc-crypto/       Vault Transit; the only Vault client
services/svc-config/       config schema; statutory rules + governance + packs
services/svc-authz/        authz schema; permission catalog, roles, org scoping, SoD
services/svc-audit/        audit schema; hash chain + verification job
services/svc-i18n/         translation bundles th/en/zh
services/svc-notify/       notify schema; in-app + SMTP
services/svc-docs/         docs schema; HTML→PDF with embedded fonts, MinIO
services/svc-onboarding/   } M1
services/svc-scheduler/    } M2
services/svc-timesheet/    } M3   scaffolded in Task 14 with real schema +
services/svc-attendance/   } M4   migrations + health; logic in Phases 2-5
services/svc-leave/        } M5
services/svc-claims/       } M6
services/svc-payroll/      } M7
services/retention-job/

web/                       React + Vite PWA shell
deploy/                    compose, prod overlay, vault config, pg init, scripts
```

Each service follows the same internal shape, so an agent that has seen one can navigate any:

```
services/<name>/
  package.json  tsconfig.json  Dockerfile
  migrations/<timestamp>_<name>.js
  src/main.ts            bootstrap: migrate, then listen on 3000
  src/app.module.ts
  src/<domain>.controller.ts    HTTP, one permission per route
  src/<domain>.service.ts       business logic, no SQL
  src/<domain>.repository.ts    SQL, own schema only
  src/<domain>.events.ts        outbox writes + consumers
```

---

## Task 1: Monorepo, tooling, and first green CI

**Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `jest.config.js`, `eslint.config.js`, `.gitignore`, `.dockerignore`, `packages/kernel/{package.json,tsconfig.json}`, `packages/kernel/src/{version.ts,index.ts}`, `.github/workflows/ci.yml`
**Test:** `packages/kernel/src/version.test.ts`

**Interfaces produced:** workspace package `@gadong/kernel`; `buildVersion(env?): string`; CI workflow `ci` with job `verify`.

- [ ] **Step 1: Write the failing test** — `packages/kernel/src/version.test.ts`

```typescript
import { buildVersion } from './version'

describe('buildVersion', () => {
  it('returns the injected git sha', () => {
    expect(buildVersion({ GADONG_BUILD_SHA: 'abc1234' } as NodeJS.ProcessEnv)).toBe('abc1234')
  })
  it('falls back to "dev" when absent', () => {
    expect(buildVersion({} as NodeJS.ProcessEnv)).toBe('dev')
  })
  it('falls back to "dev" when empty', () => {
    expect(buildVersion({ GADONG_BUILD_SHA: '' } as NodeJS.ProcessEnv)).toBe('dev')
  })
})
```

- [ ] **Step 2: Create the workspace**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
  - 'services/*'
```

Root `package.json`:
```json
{
  "name": "gadonghr",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "test": "jest",
    "build": "pnpm -r build"
  },
  "devDependencies": {
    "@eslint/js": "^9.12.0",
    "@types/jest": "^29.5.13",
    "@types/node": "^22.7.5",
    "eslint": "^9.12.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.8.1"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "composite": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

`jest.config.js`:
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages', '<rootDir>/services'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['packages/**/src/**/*.ts', 'services/**/src/**/*.ts'],
}
```

`eslint.config.js`:
```javascript
const js = require('@eslint/js')
const ts = require('typescript-eslint')

module.exports = [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      // Statutory values must come from svc-config, never a literal in code.
      // This is a blunt instrument; the real gate is review, but it catches
      // the obvious cases in payroll and leave engines.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
]
```

`packages/kernel/package.json`:
```json
{
  "name": "@gadong/kernel",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -b" }
}
```

`packages/kernel/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`.gitignore`: `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`, `.DS_Store`
`.dockerignore`: `node_modules`, `**/node_modules`, `**/dist`, `**/coverage`, `.git`, `docs`

- [ ] **Step 3: Run the test — expect FAIL**

`pnpm install && pnpm jest packages/kernel/src/version.test.ts` → `Cannot find module './version'`

- [ ] **Step 4: Implement**

`packages/kernel/src/version.ts`:
```typescript
/**
 * The image's build stamp. CI injects GADONG_BUILD_SHA at docker build time so
 * a running container traces back to an exact commit — /health reports it and
 * the deploy script asserts on it to prove the new code is actually live.
 */
export function buildVersion(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.GADONG_BUILD_SHA
  return sha && sha.length > 0 ? sha : 'dev'
}
```

`packages/kernel/src/index.ts`:
```typescript
export { buildVersion } from './version'
```

- [ ] **Step 5: Run the test — expect PASS (3 tests)**

- [ ] **Step 6: Add CI** — `.github/workflows/ci.yml`

```yaml
name: ci

on:
  push:
    branches: [main, 'phase-*']
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # No `version:` here on purpose. action-setup v4 hard-errors with
      # "Multiple versions of pnpm specified" when `version:` is given AND
      # package.json has `packageManager`. package.json is the single source
      # of truth for the pnpm version; the action reads it.
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test -- --ci
```

- [ ] **Step 7: Verify everything green, then commit**

`pnpm typecheck && pnpm lint && pnpm test`

```bash
git add -A
git commit -m "chore: pnpm workspace, @gadong/kernel, CI verify job"
```

---

## Task 2: Kernel — errors, health, effective-date resolution

**Files:** `packages/kernel/src/{errors.ts,health.ts,effective-date.ts}`, modify `index.ts`
**Tests:** `errors.test.ts`, `health.test.ts`, `effective-date.test.ts`

**Interfaces produced:**
```typescript
class GadongError extends Error { code: string; messageI18nKey: string; details: unknown[]; httpStatus: number }
function cryptoUnavailable(): GadongError            // CRY-503
function permissionDenied(permission: string): GadongError   // AUZ-403
function sodViolation(rule: string): GadongError     // AUZ-409

type DependencyState = 'up' | 'down'
interface HealthPayload { status: 'ok'|'degraded'; service: string; version: string; dependencies: Record<string, DependencyState> }
function buildHealth(service: string, deps: Record<string, DependencyState>, env?): HealthPayload

interface EffectiveRecord { effectiveFrom: string; effectiveTo: string | null }
function resolveEffective<T extends EffectiveRecord>(records: T[], on: string): T | null
```

Every later task imports these. `resolveEffective` is the single mechanism by which statutory rules are dated — payroll, leave and timesheet all resolve through it.

- [ ] **Step 1: Write the failing tests**

`effective-date.test.ts` — bounds are **inclusive on both ends**, because the Statutory Spec writes closed ranges and an exclusive upper bound silently drops the last day of every window:

```typescript
import { resolveEffective } from './effective-date'

const SSO_CEILING = [
  { effectiveFrom: '2020-01-01', effectiveTo: '2025-12-31', value: 15000 },
  { effectiveFrom: '2026-01-01', effectiveTo: null,         value: 17500 },
]
const EWF = [
  { effectiveFrom: '2026-10-01', effectiveTo: '2031-09-30', value: 0.25 },
  { effectiveFrom: '2031-10-01', effectiveTo: null,         value: 0.50 },
]

describe('resolveEffective', () => {
  it('picks the window containing the date',   () => expect(resolveEffective(SSO_CEILING,'2025-06-15')?.value).toBe(15000))
  it('effectiveFrom is inclusive',             () => expect(resolveEffective(SSO_CEILING,'2026-01-01')?.value).toBe(17500))
  it('effectiveTo is inclusive',               () => expect(resolveEffective(SSO_CEILING,'2025-12-31')?.value).toBe(15000))
  it('resolves an open-ended window',          () => expect(resolveEffective(SSO_CEILING,'2099-01-01')?.value).toBe(17500))
  // PRD M7-2 AC: Sept 2026 applies no EWF, Oct 2026 applies 0.25%, no code change.
  it('returns null before the first window',   () => expect(resolveEffective(EWF,'2026-09-30')).toBeNull())
  it('opens exactly on the effective date',    () => expect(resolveEffective(EWF,'2026-10-01')?.value).toBe(0.25))
  it('handles an empty set',                   () => expect(resolveEffective([],'2026-01-01')).toBeNull())
  it('is order-independent',                   () => expect(resolveEffective([...SSO_CEILING].reverse(),'2025-06-15')?.value).toBe(15000))
})
```

`errors.test.ts`:
```typescript
import { GadongError, cryptoUnavailable, permissionDenied, sodViolation } from './errors'

describe('GadongError', () => {
  it('serialises to the standard envelope', () => {
    expect(new GadongError('ONB-001','onboarding.error.invalid_national_id',422).toEnvelope())
      .toEqual({ code:'ONB-001', message_i18n_key:'onboarding.error.invalid_national_id', details: [] })
  })
  it('carries details', () => {
    expect(new GadongError('ONB-001','k',422,[{ field:'nationalId' }]).toEnvelope().details)
      .toEqual([{ field:'nationalId' }])
  })
})

describe('reserved errors', () => {
  it('crypto unavailable fails closed with 503', () => {
    const e = cryptoUnavailable()
    expect(e.code).toBe('CRY-503'); expect(e.httpStatus).toBe(503)
  })
  it('permission denied is 403 and names the permission', () => {
    const e = permissionDenied('payroll.run.approve')
    expect(e.code).toBe('AUZ-403'); expect(e.httpStatus).toBe(403)
    expect(e.details).toEqual([{ permission: 'payroll.run.approve' }])
  })
  it('SoD violation is 409', () => {
    expect(sodViolation('prepared_by != approved_by').httpStatus).toBe(409)
  })
})
```

`health.test.ts`:
```typescript
import { buildHealth } from './health'
const env = { GADONG_BUILD_SHA: 'deadbee' } as NodeJS.ProcessEnv

describe('buildHealth', () => {
  it('ok when all dependencies are up', () => {
    expect(buildHealth('svc-config', { db:'up' }, env))
      .toEqual({ status:'ok', service:'svc-config', version:'deadbee', dependencies:{ db:'up' } })
  })
  it('degraded when any is down', () => {
    expect(buildHealth('svc-config', { db:'up', vault:'down' }, env).status).toBe('degraded')
  })
  it('ok with no dependencies', () => {
    expect(buildHealth('svc-i18n', {}, env).status).toBe('ok')
  })
})
```

- [ ] **Step 2: Run — expect FAIL on all three (modules not found)**

- [ ] **Step 3: Implement**

`packages/kernel/src/errors.ts`:
```typescript
export class GadongError extends Error {
  constructor(
    readonly code: string,
    readonly messageI18nKey: string,
    readonly httpStatus: number,
    readonly details: unknown[] = [],
  ) {
    super(`${code}: ${messageI18nKey}`)
    this.name = 'GadongError'
  }

  toEnvelope(): { code: string; message_i18n_key: string; details: unknown[] } {
    return { code: this.code, message_i18n_key: this.messageI18nKey, details: this.details }
  }
}

/**
 * Vault sealed or svc-crypto unreachable. The caller must abandon the write.
 * There is deliberately no "skip encryption" path — a plaintext fallback would
 * defeat the product's central guarantee that a DB dump reveals nothing.
 */
export function cryptoUnavailable(): GadongError {
  return new GadongError('CRY-503', 'crypto.error.unavailable', 503)
}

export function permissionDenied(permission: string): GadongError {
  return new GadongError('AUZ-403', 'authz.error.denied', 403, [{ permission }])
}

/** Segregation of duties: same actor on both sides of a two-person control. */
export function sodViolation(rule: string): GadongError {
  return new GadongError('AUZ-409', 'authz.error.sod_violation', 409, [{ rule }])
}
```

`packages/kernel/src/health.ts`:
```typescript
import { buildVersion } from './version'

export type DependencyState = 'up' | 'down'

export interface HealthPayload {
  status: 'ok' | 'degraded'
  service: string
  version: string
  dependencies: Record<string, DependencyState>
}

/**
 * `degraded` rather than a non-200: the compose healthcheck and the deploy
 * script need to tell "the process is serving" apart from "its dependencies
 * are reachable". Vault starts SEALED after every host reboot by design
 * (Runbook §2), and a sealed Vault must not look like a crashed container.
 */
export function buildHealth(
  service: string,
  dependencies: Record<string, DependencyState>,
  env: NodeJS.ProcessEnv = process.env,
): HealthPayload {
  const anyDown = Object.values(dependencies).some((s) => s === 'down')
  return { status: anyDown ? 'degraded' : 'ok', service, version: buildVersion(env), dependencies }
}
```

`packages/kernel/src/effective-date.ts`:
```typescript
export interface EffectiveRecord {
  effectiveFrom: string      // ISO date, INCLUSIVE
  effectiveTo: string | null // ISO date, INCLUSIVE; null = open-ended
}

/**
 * Resolves which version of an effective-dated record applies on a date.
 *
 * Both bounds are INCLUSIVE. The Statutory Spec writes closed ranges
 * ("15,000 until 2025-12-31, 17,500 from 2026-01-01"); an exclusive upper
 * bound would drop the last day of every window — one wrong payslip a year,
 * which is exactly the class of defect this product exists to prevent.
 *
 * Comparison is lexicographic on YYYY-MM-DD, which is ordering-correct and
 * keeps timezones out of a question that has none.
 */
export function resolveEffective<T extends EffectiveRecord>(records: T[], on: string): T | null {
  const matches = records.filter(
    (r) => r.effectiveFrom <= on && (r.effectiveTo === null || on <= r.effectiveTo),
  )
  if (matches.length === 0) return null
  // Overlapping windows are a data defect the governance workflow should
  // prevent; if one slips through, the most recently opened window wins.
  return matches.reduce((a, b) => (a.effectiveFrom >= b.effectiveFrom ? a : b))
}
```

Update `packages/kernel/src/index.ts` to export all three modules' public surface.

- [ ] **Step 4: Run — expect PASS (17 tests total)**

- [ ] **Step 5: Verify green and commit**

`pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/kernel
git commit -m "feat(kernel): error envelope, health payload, effective-date resolution"
```

---

## Task 3: Kernel — crypto client and blind index

The single most security-critical unit in the codebase. Every S2/S3 field in every service passes through it.

**Files:** `packages/kernel/src/crypto/{types.ts,client.ts}`, modify `index.ts`
**Tests:** `packages/kernel/src/crypto/client.test.ts`

**Interfaces produced:**
```typescript
type FieldClass = 'S2' | 'S3'
interface EncryptRequest { entityId: string; field: string; value: string; fieldClass: FieldClass }
interface CryptoTransport { post(path: string, body: unknown): Promise<unknown> }   // injectable for tests

class CryptoClient {
  constructor(transport: CryptoTransport)
  encryptBatch(reqs: EncryptRequest[]): Promise<Map<string, Buffer>>   // keyed by field name
  decrypt(entityId: string, field: string, ciphertext: Buffer, purpose: string): Promise<string>
  blindIndex(fieldClass: FieldClass, field: string, value: string): Promise<Buffer>
  normalise(value: string): string
}
```

`purpose` on `decrypt` is mandatory and non-empty — it is what the audit entry records, and Security doc §5 requires every S3 read to carry one.

- [ ] **Step 1: Write the failing tests**

```typescript
import { CryptoClient } from './client'
import type { CryptoTransport } from './client'
import { GadongError } from '../errors'

const okTransport = (responses: Record<string, unknown>): CryptoTransport => ({
  post: jest.fn(async (path: string) => {
    if (!(path in responses)) throw new Error(`unexpected path ${path}`)
    return responses[path]
  }),
})

describe('CryptoClient.normalise', () => {
  const c = new CryptoClient(okTransport({}))
  it('trims, lowercases and NFKC-folds so a blind index matches variants', () => {
    expect(c.normalise('  Somchai@Example.COM ')).toBe('somchai@example.com')
  })
  it('folds full-width characters to their canonical form', () => {
    expect(c.normalise('ＡＢＣ')).toBe('abc')
  })
})

describe('CryptoClient.encryptBatch', () => {
  it('sends entityId and field so the service can bind them as AAD', async () => {
    const transport = okTransport({
      '/encrypt': { fields: { national_id: Buffer.from('ct1').toString('base64') } },
    })
    const c = new CryptoClient(transport)
    const out = await c.encryptBatch([
      { entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' },
    ])
    expect(out.get('national_id')).toEqual(Buffer.from('ct1'))
    expect(transport.post).toHaveBeenCalledWith('/encrypt', {
      fields: [{ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }],
    })
  })

  it('fails closed with CRY-503 when the crypto service is unreachable', async () => {
    const transport: CryptoTransport = { post: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([{ entityId: 'e', field: 'f', value: 'v', fieldClass: 'S3' }]),
    ).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
  })

  it('never returns a partial result when one field fails', async () => {
    const transport = okTransport({ '/encrypt': { fields: { a: Buffer.from('x').toString('base64') } } })
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([
        { entityId: 'e', field: 'a', value: '1', fieldClass: 'S2' },
        { entityId: 'e', field: 'b', value: '2', fieldClass: 'S2' },
      ]),
    ).rejects.toBeInstanceOf(GadongError)
  })
})

describe('CryptoClient.decrypt', () => {
  it('requires a non-empty purpose — the audit entry depends on it', async () => {
    const c = new CryptoClient(okTransport({}))
    await expect(c.decrypt('emp-1', 'national_id', Buffer.from('ct'), '')).rejects.toThrow(/purpose/i)
  })

  it('passes entityId and field so AAD is reconstructed on the service side', async () => {
    const transport = okTransport({ '/decrypt': { value: '1101700207364' } })
    const c = new CryptoClient(transport)
    const v = await c.decrypt('emp-1', 'national_id', Buffer.from('ct'), 'payroll_sso_filing')
    expect(v).toBe('1101700207364')
    expect(transport.post).toHaveBeenCalledWith('/decrypt', {
      entityId: 'emp-1',
      field: 'national_id',
      ciphertext: Buffer.from('ct').toString('base64'),
      purpose: 'payroll_sso_filing',
    })
  })

  it('fails closed on transport error', async () => {
    const transport: CryptoTransport = { post: jest.fn().mockRejectedValue(new Error('sealed')) }
    await expect(
      new CryptoClient(transport).decrypt('e', 'f', Buffer.from('c'), 'p'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })
})

describe('CryptoClient.blindIndex', () => {
  it('normalises before hashing so lookups match on case and spacing', async () => {
    const transport = okTransport({ '/bidx': { bidx: Buffer.from('h').toString('base64') } })
    const c = new CryptoClient(transport)
    await c.blindIndex('S3', 'email', '  Somchai@Example.COM ')
    expect(transport.post).toHaveBeenCalledWith('/bidx', {
      fieldClass: 'S3', field: 'email', value: 'somchai@example.com',
    })
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** `packages/kernel/src/crypto/client.ts`

Requirements the implementation must satisfy, all covered by the tests above:
- `normalise` = `String.prototype.normalize('NFKC')` → `trim()` → `toLowerCase()`.
- `encryptBatch` posts every field in one request and returns a `Map<field, Buffer>`; if the response is missing any requested field, throw `GadongError` rather than returning a partial map — a partial map would let a caller write one plaintext column believing it encrypted.
- Any transport rejection converts to `cryptoUnavailable()`. Wrap in try/catch; do not let a raw network error escape, because callers distinguish `CRY-503` from a bug.
- `decrypt` throws `new Error('purpose is required')` on an empty purpose **before** touching the transport.
- Ciphertext crosses the wire base64-encoded; the client converts at the boundary so services only ever handle `Buffer`.

Export from `crypto/types.ts` and re-export through `index.ts`.

- [ ] **Step 4: Run — expect PASS (9 tests)**

- [ ] **Step 5: Verify green and commit**

```bash
git add packages/kernel
git commit -m "feat(kernel): crypto client with fail-closed semantics and blind index normalisation"
```

---

## Task 4: Kernel — transactional outbox, relay, idempotent consumer

**Files:** `packages/kernel/src/outbox/{outbox.ts,relay.ts,consumer.ts}`, `packages/kernel/src/db/pool.ts`, modify `index.ts`
**Tests:** `outbox.test.ts`, `relay.test.ts`, `consumer.test.ts`

**Interfaces produced:**
```typescript
interface OutboxRow { id: string; topic: string; payload: unknown; createdAt: Date; publishedAt: Date | null }
interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

function writeOutbox(tx: Queryable, topic: string, payload: unknown): Promise<string>

interface Publisher { publish(topic: string, payload: unknown, messageId: string): Promise<void> }
class OutboxRelay {
  constructor(pool: Queryable, publisher: Publisher, schema: string)
  drainOnce(batchSize?: number): Promise<{ published: number; failed: number }>
}

function idempotent<T>(tx: Queryable, schema: string, eventId: string, handler: () => Promise<T>): Promise<T | 'duplicate'>
```

ADR-005's guarantee lives here: producers write state and outbox row in one transaction, the relay publishes at-least-once, consumers make the effect exactly-once.

- [ ] **Step 1: Write the failing tests**

Key cases the tests must cover (write them in full):
- `writeOutbox` inserts into `<schema>.outbox` using the caller's transaction handle, never its own connection — a separate connection would break atomicity, which is the entire point.
- `writeOutbox` serialises the payload as JSON and returns the generated id.
- `OutboxRelay.drainOnce` selects rows with `published_at IS NULL` ordered by `created_at`, `FOR UPDATE SKIP LOCKED`, publishes each, then stamps `published_at`.
- A publish failure leaves `published_at` NULL so the row is retried, and `drainOnce` reports it in `failed` without throwing — one poisoned message must not stall the queue.
- The relay stamps `published_at` **after** a successful publish, never before. Test by making the publisher throw and asserting the row is still unpublished.
- `idempotent` inserts into `<schema>.processed_events` and runs the handler; on a duplicate key it returns `'duplicate'` without running the handler.
- Triple delivery of the same `eventId` runs the handler exactly once (XC-EVENTS).

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement.** Note for the implementer: `idempotent` must do the `INSERT ... ON CONFLICT DO NOTHING` and the handler **inside the caller's transaction**, so a handler failure rolls back the processed-events row and the event is redelivered. Inserting in a separate transaction would mark an event processed that never took effect — silent data loss, and the hardest class of bug to find later.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** — `feat(kernel): transactional outbox, relay, and idempotent consumer`

---

## Task 5: Kernel — authz guard, audit emitter, i18n formatting

**Files:** `packages/kernel/src/authz/{client.ts,guard.ts}`, `packages/kernel/src/audit/emitter.ts`, `packages/kernel/src/i18n/format.ts`, modify `index.ts`
**Tests:** one per module.

**Interfaces produced:**
```typescript
const RequirePermission: (p: string) => MethodDecorator
interface Decision { allowed: boolean; scopeOrgUnitIds: string[] | '*' | 'self' }
class AuthzClient { decide(userId: string, permission: string): Promise<Decision> }
class PermissionGuard implements CanActivate   // reads @RequirePermission, calls AuthzClient, throws permissionDenied()

interface AuditEntry { actorId: string; actorRole: string; action: string; entity: string; entityId: string; purpose?: string; before?: unknown; after?: unknown }
class AuditEmitter { emit(tx: Queryable, schema: string, entry: AuditEntry): Promise<void> }   // writes to outbox as audit.<action>

function toBuddhistEra(iso: string): number                    // 2026 -> 2569
function formatDate(iso: string, locale: 'th'|'en'|'zh'): string
function formatTHB(satang: bigint, locale: 'th'|'en'|'zh'): string
```

- [ ] **Step 1: Write the failing tests.** Must include:
  - A controller method with no `@RequirePermission` causes the guard to **deny**, not allow. Deny-by-default has to be structural, not a convention.
  - `PermissionGuard` throws `AUZ-403` with the permission name in details.
  - Decisions are cached and invalidated by a `rules.updated`-style signal; a cache that never invalidates would freeze a revoked grant.
  - `AuditEmitter.emit` writes through the caller's transaction to the outbox — an audit entry must not survive a rolled-back write, nor be lost when the write succeeds.
  - `emit` requires a non-empty `purpose` when `action` ends in `.sensitive.read`.
  - `toBuddhistEra('2026-08-02')` is `2569`.
  - `formatDate('2026-08-02','th')` renders a B.E. year; `'en'` and `'zh'` render Gregorian.
  - `formatTHB` keeps satang precision and never rounds — rounding happens at render only, and money arrives as `bigint` satang so no float ever touches a payroll figure.

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(kernel): permission guard, audit emitter, and locale formatting`

---

## Tasks 6–13: the seven platform services

Each follows the same shape. For each: migrations first, then repository, then service, then controller with permissions, then events, then Dockerfile. Each ends with `pnpm typecheck && pnpm lint && pnpm test` green and one commit.

| Task | Service | Must deliver |
|---|---|---|
| **6** | `svc-crypto` | The only Vault client. `POST /encrypt` (batch), `/decrypt`, `/bidx`, `GET /health` reporting Vault seal state. Envelope encryption per the roadmap's ciphertext layout with **AAD = `entityId:field`**. Per-class KEKs (`kek-<class>`), per-record DEKs. Sealed Vault ⇒ 503, no fallback. A test must prove that decrypting employee A's ciphertext with employee B's `entityId` **fails**, not returns garbage. |
| **7** | `svc-config` | `config` schema per DATABASE-DESIGN §2.6. `GET /rules/:key?on=`, `POST /rules` (propose → `draft`), `POST /rules/:id/approve`. Floor validation: a `STATUTORY_FLOOR` rule below its floor is rejected with the citation; `STATUTORY_FIXED` is editable only by signed pack import. `proposed_by ≠ approved_by` enforced by DB constraint **and** service check. Seed loader for `TH-STATUTORY`, `TH-HOLIDAYS-2026`, `TH-MINWAGE`, `TH-PROVINCES`, `TH-BANKS`, idempotent by `(pack_id, version)`. Emits `rules.updated`. |
| **8** | `svc-authz` | `authz` schema. `POST /decide` returning `{allowed, scopeOrgUnitIds}`. Permission catalog and the ten role templates seeded from the roadmap. Org-unit subtree scoping; `self` scope. SoD checks. **A test asserts no seeded human role carries `biometric.template.read`.** Consumes `employee.created` to maintain the org tree read model. |
| **9** | `svc-audit` | `audit` schema, INSERT+SELECT grants only — a test must prove UPDATE and DELETE are refused at the DB level. Consumes `audit.*` from the broker. `entry_hash = SHA256(prev_entry_hash ‖ canonical_json(entry))`. `GET /verify` walks the chain and reports the first break. A test tampers with one row and asserts verification detects it. Daily chain-head anchor to a file volume. |
| **10** | `svc-i18n` | `GET /bundles/:locale` for `th`/`en`/`zh`. Bundles as JSON in the repo. Missing key → English fallback + a logged warning carrying the key. A CI check asserts every key referenced in code exists in all three bundles. Glossary from I18N-GUIDE §2. |
| **11** | `svc-notify` | `notify` schema. In-app notifications + SMTP. Templates render in the **recipient's** preferred language, not the actor's. Consumes `leave.approved`, `claim.approved_for_payroll`, `payslip.issued`, `employee.created`. Idempotent — a duplicate event must not send a second email. |
| **12** | `svc-docs` | `docs` schema. HTML→PDF via headless Chromium with **Sarabun, Noto Sans SC and Noto Sans embedded in the image**. `POST /render` returns a MinIO reference; the file is encrypted before upload. Thai documents render B.E. dates. Golden-file tests assert Thai and Chinese glyphs render rather than falling back to tofu — this is the failure mode that silently ships. |
| **13** | Compose + prod overlay | `deploy/docker-compose.prod.yml` (GHCR images, mem limits, no build), `deploy/vault/vault.hcl` (raft, no auto-unseal), `deploy/postgres/init/01-roles.sql` (all 12 schema roles with per-role connection limits and statement timeouts), `deploy/scripts/{auto-deploy-gadonghr.sh,prune-gadonghr-images.sh}`. Validated with `docker compose config` before anything is deployed. |

---

## Task 13b: Integration tests against real Postgres

Task 4's outbox, relay and consumer are tested against an in-memory fake. The Task 4 review
mutation-tested that fake and judged it genuine — 10 of 12 mutations caught, including every one
that would lose or duplicate a punch event. But it named five things the fake **structurally
cannot** catch. Each is a silent-loss path in the pipeline that carries a worker's punch to their
payslip, so each gets a test against a real Postgres in the compose test profile.

**Files:** `services/svc-config/test/integration/outbox.integration.test.ts` (first service with a
schema; the suite is shared and re-run per service thereafter).

- [ ] **(a) Transaction abort poisons the rest of the batch.** The fake happily runs statements
  after a failed one. Real Postgres does not: once a statement errors inside a transaction, every
  later statement fails until rollback, and COMMIT becomes a silent ROLLBACK. So the relay's
  per-row `catch` — correct against the fake — may swallow a SQL error and then lose the whole
  batch while reporting success. Test: force one row's UPDATE to fail mid-batch, assert what
  actually persists.

- [ ] **(b) No-transaction lock release.** Removing `BEGIN`/`COMMIT` from `drainOnce` leaves every
  unit test passing, but in real Postgres it releases every row lock the instant the SELECT
  returns, so two relays double-publish. Test: run two `drainOnce` calls concurrently against one
  batch, assert each row publishes exactly once.

- [ ] **(c) `search_path` resolution.** Assert every outbox write lands in the intended schema when
  `search_path` is deliberately set to something else.

- [ ] **(d) Concurrent `ON CONFLICT DO NOTHING`.** Real Postgres blocks the second inserter until
  the first commits or aborts; the fake lets both through, so exactly-once under true concurrency
  is currently unproven. Test: two concurrent `idempotent` calls with the same `event_id`, assert
  the handler runs exactly once.

- [ ] **(e) The `processed_events(event_id PK)` DDL itself.** Without that primary key the dedupe
  degrades silently to a no-op. Assert the constraint exists and that a duplicate insert conflicts.

- [ ] **(f) Relay `ORDER BY created_at` and `LIMIT`.** Deleting either leaves all unit tests green
  because the fake sorts and slices unconditionally. Assert ordering and batch size against real
  rows.

- [ ] Commit — `test(kernel): integration suite for outbox semantics real Postgres only`

---

## Task 14: Scaffold the seven module services

All of M1–M7 exist in the repo with their real schema, migrations and health endpoint, so Phases 2–5 add logic to a structure that is already wired, reviewed and deploying.

**For each of** `svc-onboarding`, `svc-scheduler`, `svc-timesheet`, `svc-attendance`, `svc-leave`, `svc-claims`, `svc-payroll`, plus `retention-job`:

- Package, tsconfig, Dockerfile matching the platform services.
- Migration creating the service's schema exactly as DATABASE-DESIGN §2 specifies, including every 🔐 column as `bytea`, every `*_bidx` companion, and the mandatory `outbox` and `processed_events` tables.
- `src/main.ts` running migrations then listening on 3000.
- `GET /health` reporting `db` and, where the service uses it, `crypto`.
- Registered in `deploy/docker-compose.yml` and the prod overlay.
- A test asserting the migration applies cleanly and every 🔐 column is `bytea`, not `text`. A sensitive column typed `text` is the exact defect the product cannot ship, and it is far cheaper to catch here than in Phase 5.

- [ ] Commit per service — `feat(svc-<name>): schema, migrations, and health endpoint`

---

## Task 15: Build all images in CI and publish to GHCR

**Files:** modify `.github/workflows/ci.yml`

- Matrix over all 15 services plus `web`.
- Tags `:${{ github.sha }}` and `:main`; build arg `GADONG_BUILD_SHA`.
- `mark-ci-pass` job writes `refs/ci-pass/<sha>` **last**, after every image push, so the marker's existence proves the images the server is about to pull exist.
- Verify: `git ls-remote origin "refs/ci-pass/*"` returns the sha, and `docker manifest inspect` succeeds for each image.

- [ ] Commit — `ci: build and publish all service images to GHCR`

---

## Task 15b: Keycloak realm and service-account provisioning

Found during Task 13c. The OIDC middleware validates tokens; nothing issues them. Keycloak runs in
compose with no realm, no clients and no users, so `seed.sh` has no token source and the first
deploy can seed nothing. This blocks Task 16.

- [ ] `deploy/keycloak/realm-gadonghr.json` — realm import: the `gadonghr` realm, a `web` public
  client for the PWA (authorization code + PKCE), and a `seeder` confidential client with a service
  account holding `config.pack.import` and `authz.role.grant`.
- [ ] Realm settings: token lifetime <= 12 h with refresh rotation, brute-force detection on,
  argon2id password hashing (Security doc S6).
- [ ] `deploy/scripts/bootstrap-admin.sh` — creates the first HR/System Admin and forces MFA setup.
- [ ] `seed.sh` obtains a service-account token via client credentials before importing packs.
- [ ] Test: the realm JSON parses, declares the two clients, and the seeder's service account carries
  exactly the two permissions it needs and no others.
- [ ] Commit — `feat(deploy): Keycloak realm import and service-account provisioning`

---

## Task 16: First deployment to gadonghr-prod

**Host:** `157.230.38.96`. DNS cutover from 165 happens here.

- [ ] Clone to `/root/GaDongHR`, write `.env` server-side (chmod 600), generate every secret with `openssl rand -base64 32`.
- [ ] `docker compose --profile core pull && up -d`, migrations run at boot.
- [ ] **Vault ceremony** (Runbook §2): `vault-init.sh` → 5 Shamir shares, threshold 3 → record officers in `signoff/key-register.md`. Say the "loss of 3 shares = permanent data loss" line out loud. AppRole secret to `deploy/secrets/vault_approle_secret`.
- [ ] Seed packs: `scripts/seed.sh`. Run twice; assert identical state.
- [ ] Verify **before** touching DNS: `curl -H 'Host: hr.bevorasg.com' http://157.230.38.96/api/config/health` returns `{"status":"ok"}`.
- [ ] **Then** lower the `hr` A record TTL, repoint it from `165.22.246.45` to `157.230.38.96`, and verify. Touch no other record in the zone — the other eight carry BamForm, BillSplit, Noodle CRM, IMS and Bevora Sign.
- [ ] Traefik obtains the certificate once DNS resolves; confirm the issuer is Let's Encrypt.
- [ ] Install both crons (deploy + image prune), back up the crontab first.
- [ ] **Prove the loop:** push a trivial change, watch `=== Deploy OK: <sha> ===`, confirm `/api/config/health` reports the new sha.
- [ ] **Prove encrypt-before-write:** insert a fixture employee, then `pg_dump` the row and assert the national ID plaintext does not appear anywhere in the dump. This is the product's central claim; it gets verified on the real server, not only in tests.
- [ ] **Prove fail-closed:** seal Vault, attempt an S3 write, assert 503 and no row written. Unseal.
- [ ] Commit — `docs: record Phase 1 deployment`

---

## Exit criteria

Phase 1 is done when all of these hold on the live host:

1. `https://hr.bevorasg.com` serves with a Let's Encrypt certificate.
2. A `pg_dump` contains no plaintext for any 🔐 column.
3. Decrypting one employee's ciphertext under another's `entityId` fails.
4. A sealed Vault turns S3 writes into 503 with no row written.
5. Every route without an explicit permission is denied.
6. No seeded human role holds `biometric.template.read`.
7. Tampering with one audit row is detected by `GET /verify`.
8. The same event delivered three times produces one effect.
9. Seeding twice produces identical state.
10. A statutory rule resolves differently for 2026-09-30 and 2026-10-01 with no code change.
11. Push to `main` reaches the server automatically, and the health endpoint reports the new sha.
