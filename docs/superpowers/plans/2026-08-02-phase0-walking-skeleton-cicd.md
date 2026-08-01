# GaDongHR Phase 0 — Walking Skeleton + First CI/CD Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the GaDongHR monorepo, the shared `@gadong/kernel`, the first real service (`svc-config`), and a build-in-CI → push-to-GHCR → pull-on-server pipeline that deploys to `https://hr.bevorasg.com` on droplet 165 without colliding with the 68 containers and 28 nginx vhosts already running there.

**Architecture:** GitHub Actions builds and tests every commit, publishes SHA-tagged images to GHCR, and writes a `refs/ci-pass/<sha>` marker. A per-minute `flock`-guarded cron on 165 pulls those images and restarts only the `gadonghr` compose project. **Nothing is ever built on 165** — an on-box BuildKit build panicked dockerd on 2026-07-29 and killed all 61 containers for five hours. TLS terminates at the host nginx that already fronts the box; the stack publishes loopback-only ports from a reserved, verified-free block.

**Tech Stack:** Node.js 22 · TypeScript 5.x · NestJS 10 · pnpm workspaces · Jest · node-pg-migrate · PostgreSQL 16 · Docker Compose v5 · GitHub Actions · GHCR · host nginx + certbot.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are verified against droplet 165 on 2026-08-02 unless noted.

**Target host — droplet 165 (`165.22.246.45`)**
- DigitalOcean **Bevora** account (`samuel@vorkhive.com`). Not the RMA account. `165.22.240.22` is a *different company's* box — four characters apart.
- 4 vCPU · 7 GB RAM (2 GB available, 6 GB swap of which 3 GB already used) · 154 GB disk at 55% · load average 5.3.
- **68 running containers across 20 compose projects**, including other developers' production (`mmcafe` belongs to Levi Jan Clavesillas). Run `git remote -v` before touching an unfamiliar stack.
- SSH: `root@165.22.246.45`, key auth, works from this Mac.

**Port rules**
- Host **nginx owns `0.0.0.0:80` and `0.0.0.0:443`** for 28 vhosts. The stack must never publish 80 or 443. `deploy/docker-compose.yml` currently does (`ports: ["80:80","443:443"]` on `traefik`) — that file is the standalone/customer artifact and stays as is; the 165 overlay disables Traefik.
- **Reserved block for GaDongHR: `21000–21029`, verified entirely free.** Every publish is loopback-scoped (`127.0.0.1:PORT:...`), matching every other stack on the box.
- Ports already taken (do not use): 3000-3003, 3010, 3013, 3020, 3100, 4000-4013, 4016, 4020, 4210, 4998, 5433, 5444, 8010, 8088, 8091, 9000, 9001, 9010, 10000, 10502, 13200, 13201, 13300, 20001, 20002, 20011, 20012, 20021, 20031-20033, 20050-20052, 20101, 20201.

**Assigned port map** (only the first three are used in Phase 0):

| Port | Service | Phase |
|---|---|---|
| 21000 | `web` PWA | 0 |
| 21001 | `keycloak` | 0 |
| 21020 | `svc-config` | 0 |
| 21021 | `svc-authz` | A |
| 21010–21016 | `svc-onboarding` … `svc-payroll` (M1…M7 order) | A–D |
| 21029 | `grafana` (observability profile) | E |

**Docker network**
- Subnets `172.17.0.0/16` through `172.31.0.0/16` are **fully exhausted** on 165, and `192.168.0.0/20` … `192.168.112.0/20` are taken. Pin `gadong-internal` to **`192.168.128.0/20`** explicitly — do not rely on auto-allocation.

**Naming**
- Compose project name is `gadonghr` (already set via `name:` in `deploy/docker-compose.yml`).
- **Never set `container_name:`.** Default `gadonghr-<service>-<n>` names avoid collision with the existing 20-container `newhrms` stack, which already owns `hrms-attendance`, `hrms-payroll`, `hrms-face`, etc.

**Build & deploy rules (non-negotiable — learned from outages on this exact box)**
- Images are built **only** in GitHub Actions and pulled from `ghcr.io/mavrone81/gadonghr-<service>`. Never `docker compose build` on 165.
- Images are SHA-tagged. SHA-tagged images are **never dangling**, so `docker system prune -f` cannot reclaim them — this is precisely the BamForm leak that ate ~3 GB/deploy. A scoped keep-4 prune cron ships in Task 7, not later.
- Never `docker compose down -v`, never `docker system prune --volumes`, never `docker container prune` on this box.
- Every deploy command is scoped to the `gadonghr` project.

**Repo conventions**
- Node 22, TypeScript strict, pnpm workspaces. Services live in `services/<name>`, shared code in `packages/kernel`.
- Secrets never committed. `deploy/.gitignore` already excludes `.env`, `secrets/`, `letsencrypt/`.
- Commit messages: conventional commits (`feat:`, `fix:`, `chore:`, `ci:`).

**Domain**
- `hr.bevorasg.com` **already resolves to 165.22.246.45** (verified against `ns1.digitalocean.com`; there is no wildcard). No DNS work is required. It currently serves the box's self-signed catch-all — Task 6 issues the real certificate.

---

## ⚠ Capacity Finding — read before Task 5

`docs/04-architecture/ARCHITECTURE-OVERVIEW.md` §7 sizes GaDongHR at **8 vCPU / 16 GB / 200 GB** for the full `core` profile (~24 containers: 15 Node services, 2 Postgres, RabbitMQ, Redis, MinIO, Vault, 3 CompreFace, ClamAV, web).

Droplet 165 today: **4 vCPU, 2 GB RAM available, 3 GB of 6 GB swap already consumed, load average 5.3 on 4 cores.** The full stack does not fit, and CompreFace alone wants 2–3 GB.

This plan therefore deploys a **Phase 0 slice only** — `postgres`, `vault`, `svc-crypto`, `svc-config`, `keycloak`, `web` — with hard `mem_limit`s totalling ≈1.6 GB. That proves the pipeline end to end and is what Task 8 verifies.

**Everything beyond Phase 0 is gated on a capacity decision that is the user's to make:** resize 165 (8 vCPU / 16 GB), or give GaDongHR its own droplet. Do not schedule Phase A tasks against 165 at its current size. Raise this before starting Task 5.

---

## File Structure

**Created by this plan:**

| Path | Responsibility |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` | Workspace root; shared TS config |
| `.github/workflows/ci.yml` | Typecheck → lint → test → build images → push GHCR → write `refs/ci-pass/<sha>` |
| `packages/kernel/src/version.ts` | Build-stamp accessor — the first thing CI proves |
| `packages/kernel/src/health.ts` | Shared health-payload builder used by every service |
| `packages/kernel/src/effective-date.ts` | Effective-dated rule resolution (Statutory Spec §1) |
| `services/svc-config/src/main.ts` | NestJS bootstrap |
| `services/svc-config/src/health.controller.ts` | `GET /health` |
| `services/svc-config/src/rules.controller.ts` | `GET /rules/:key` |
| `services/svc-config/src/rules.repository.ts` | Postgres access, `config` schema only |
| `services/svc-config/migrations/1690000000000_statutory-rule.js` | `config.statutory_rule` table |
| `services/svc-config/Dockerfile` | Multi-stage, non-root, distroless-ish runtime |
| `deploy/docker-compose.165.yml` | **The port-safe overlay** — Traefik off, loopback publishes, pinned subnet, mem limits, GHCR images |
| `deploy/vault/vault.hcl` | Referenced by the base compose but absent today |
| `deploy/postgres/init/01-roles.sql` | Referenced by the base compose but absent today; schema-per-service roles |
| `deploy/nginx/hr.bevorasg.com.conf` | Canonical copy of the host vhost |
| `deploy/scripts/preflight-ports.sh` | Refuses to deploy if the reserved block is occupied |
| `deploy/scripts/auto-deploy-gadonghr.sh` | CI-gated, self-healing, project-scoped pull-deploy |
| `deploy/scripts/prune-gadonghr-images.sh` | Keep-4 scoped image prune (the BamForm-leak guard) |

**Modified:** `deploy/.env.example` (adds the 165 overlay variables), `README.md` (deployment section).

---

## Task 1: Monorepo scaffold and first green CI run

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `jest.config.js`
- Create: `packages/kernel/package.json`, `packages/kernel/tsconfig.json`, `packages/kernel/src/version.ts`
- Create: `.github/workflows/ci.yml`
- Test: `packages/kernel/src/version.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: workspace package `@gadong/kernel`; exported `buildVersion(env?: NodeJS.ProcessEnv): string`. CI workflow named `ci` with a job id `verify`.

- [ ] **Step 1: Write the failing test**

Create `packages/kernel/src/version.test.ts`:

```typescript
import { buildVersion } from './version'

describe('buildVersion', () => {
  it('returns the injected git sha when GADONG_BUILD_SHA is set', () => {
    expect(buildVersion({ GADONG_BUILD_SHA: 'abc1234' } as NodeJS.ProcessEnv)).toBe('abc1234')
  })

  it('falls back to "dev" when the sha is absent', () => {
    expect(buildVersion({} as NodeJS.ProcessEnv)).toBe('dev')
  })

  it('falls back to "dev" when the sha is an empty string', () => {
    expect(buildVersion({ GADONG_BUILD_SHA: '' } as NodeJS.ProcessEnv)).toBe('dev')
  })
})
```

- [ ] **Step 2: Create the workspace so the test can run**

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
    "test": "jest"
  },
  "devDependencies": {
    "@types/jest": "^29.5.13",
    "@types/node": "^22.7.5",
    "eslint": "^9.12.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5",
    "typescript": "^5.6.3"
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
    "forceConsistentCasingInFileNames": true
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

`.gitignore` at repo root:

```
node_modules/
dist/
coverage/
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm install && pnpm jest packages/kernel/src/version.test.ts`
Expected: FAIL — `Cannot find module './version'`

- [ ] **Step 4: Write the minimal implementation**

`packages/kernel/src/version.ts`:

```typescript
/**
 * The image's build stamp. CI injects GADONG_BUILD_SHA at docker build time so
 * a running container can be traced back to an exact commit — the deploy script
 * and the /health endpoint both rely on this to prove which code is live.
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

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm jest packages/kernel/src/version.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Add the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test -- --ci
```

- [ ] **Step 7: Commit and confirm CI is green**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json jest.config.js .gitignore packages .github
git commit -m "chore: pnpm workspace, @gadong/kernel, and CI verify job"
git push
```

Then: `gh run watch` — expected conclusion `success`. **Do not proceed to Task 2 until CI is green**; every later task assumes this gate works.

---

## Task 2: Kernel health payload

**Files:**
- Create: `packages/kernel/src/health.ts`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/src/health.test.ts`

**Interfaces:**
- Consumes: `buildVersion` from Task 1.
- Produces:
  ```typescript
  type DependencyState = 'up' | 'down'
  interface HealthPayload {
    status: 'ok' | 'degraded'
    service: string
    version: string
    dependencies: Record<string, DependencyState>
  }
  function buildHealth(service: string, dependencies: Record<string, DependencyState>, env?: NodeJS.ProcessEnv): HealthPayload
  ```
  Task 3's `HealthController` and Task 7's deploy script both depend on this exact shape.

- [ ] **Step 1: Write the failing test**

`packages/kernel/src/health.test.ts`:

```typescript
import { buildHealth } from './health'

describe('buildHealth', () => {
  const env = { GADONG_BUILD_SHA: 'deadbee' } as NodeJS.ProcessEnv

  it('reports ok when every dependency is up', () => {
    expect(buildHealth('svc-config', { db: 'up' }, env)).toEqual({
      status: 'ok',
      service: 'svc-config',
      version: 'deadbee',
      dependencies: { db: 'up' },
    })
  })

  it('reports degraded when any dependency is down', () => {
    const result = buildHealth('svc-config', { db: 'up', vault: 'down' }, env)
    expect(result.status).toBe('degraded')
  })

  it('reports ok when there are no dependencies to check', () => {
    expect(buildHealth('svc-config', {}, env).status).toBe('ok')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm jest packages/kernel/src/health.test.ts`
Expected: FAIL — `Cannot find module './health'`

- [ ] **Step 3: Write the minimal implementation**

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
 * `degraded` rather than a non-200 status: the compose healthcheck and the
 * deploy script want to distinguish "the process is serving" from "its
 * dependencies are reachable". A hard failure would make a Vault-sealed box
 * look identical to a crashed container, and Vault starts sealed after every
 * reboot by design (Operations Runbook §2).
 */
export function buildHealth(
  service: string,
  dependencies: Record<string, DependencyState>,
  env: NodeJS.ProcessEnv = process.env,
): HealthPayload {
  const anyDown = Object.values(dependencies).some((state) => state === 'down')
  return {
    status: anyDown ? 'degraded' : 'ok',
    service,
    version: buildVersion(env),
    dependencies,
  }
}
```

Append to `packages/kernel/src/index.ts`:

```typescript
export { buildHealth } from './health'
export type { HealthPayload, DependencyState } from './health'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm jest packages/kernel/src/health.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel
git commit -m "feat(kernel): shared health payload builder"
```

---

## Task 3: svc-config with effective-dated rule resolution

The first real service. It owns the `config` schema and answers "what was the value of this statutory rule on this date?" — the question every other module eventually asks (Statutory Spec §1, PRD §7.4).

**Files:**
- Create: `packages/kernel/src/effective-date.ts`
- Create: `services/svc-config/package.json`, `tsconfig.json`, `src/main.ts`, `src/app.module.ts`, `src/health.controller.ts`, `src/rules.controller.ts`, `src/rules.repository.ts`
- Create: `services/svc-config/migrations/1690000000000_statutory-rule.js`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/src/effective-date.test.ts`, `services/svc-config/src/health.controller.test.ts`

**Interfaces:**
- Consumes: `buildHealth`, `HealthPayload` from Task 2.
- Produces:
  ```typescript
  interface EffectiveRecord { effectiveFrom: string; effectiveTo: string | null }
  function resolveEffective<T extends EffectiveRecord>(records: T[], on: string): T | null
  ```
  Service listens on container port `3000`; endpoints `GET /health` and `GET /rules/:key?on=YYYY-MM-DD`. Task 5 publishes it on `127.0.0.1:21020`; Task 8 verifies `GET /health`.

- [ ] **Step 1: Write the failing test for effective-date resolution**

`packages/kernel/src/effective-date.test.ts`:

```typescript
import { resolveEffective } from './effective-date'

const SSO_CEILING = [
  { effectiveFrom: '2020-01-01', effectiveTo: '2025-12-31', value: 15000 },
  { effectiveFrom: '2026-01-01', effectiveTo: null, value: 17500 },
]

const EWF = [
  { effectiveFrom: '2026-10-01', effectiveTo: '2031-09-30', value: 0.25 },
  { effectiveFrom: '2031-10-01', effectiveTo: null, value: 0.5 },
]

describe('resolveEffective', () => {
  it('picks the window containing the date', () => {
    expect(resolveEffective(SSO_CEILING, '2025-06-15')?.value).toBe(15000)
  })

  it('treats effectiveFrom as inclusive', () => {
    expect(resolveEffective(SSO_CEILING, '2026-01-01')?.value).toBe(17500)
  })

  it('treats effectiveTo as inclusive', () => {
    expect(resolveEffective(SSO_CEILING, '2025-12-31')?.value).toBe(15000)
  })

  it('resolves an open-ended window', () => {
    expect(resolveEffective(SSO_CEILING, '2099-01-01')?.value).toBe(17500)
  })

  // PRD M7-2 AC: September 2026 must apply no EWF, October 2026 must apply
  // 0.25% — with no software change, only effective-dated config.
  it('returns null before the first window opens', () => {
    expect(resolveEffective(EWF, '2026-09-30')).toBeNull()
  })

  it('returns the first EWF rate on its effective date', () => {
    expect(resolveEffective(EWF, '2026-10-01')?.value).toBe(0.25)
  })

  it('returns null for an empty record set', () => {
    expect(resolveEffective([], '2026-01-01')).toBeNull()
  })

  it('does not depend on input ordering', () => {
    expect(resolveEffective([...SSO_CEILING].reverse(), '2025-06-15')?.value).toBe(15000)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest packages/kernel/src/effective-date.test.ts`
Expected: FAIL — `Cannot find module './effective-date'`

- [ ] **Step 3: Implement effective-date resolution**

`packages/kernel/src/effective-date.ts`:

```typescript
export interface EffectiveRecord {
  effectiveFrom: string // ISO date, inclusive
  effectiveTo: string | null // ISO date, inclusive; null = open-ended
}

/**
 * Resolves which version of an effective-dated rule applies on a given date.
 *
 * Both bounds are INCLUSIVE. The Statutory Spec writes windows as closed
 * ranges ("15,000 until 2025-12-31, 17,500 from 2026-01-01"), and an
 * exclusive upper bound would silently drop the last day of every window —
 * the kind of defect that shows up as one wrong payslip a year.
 *
 * Comparison is lexicographic on ISO-8601 date strings, which is ordering-
 * correct for YYYY-MM-DD and avoids dragging a timezone into a question that
 * has none.
 */
export function resolveEffective<T extends EffectiveRecord>(records: T[], on: string): T | null {
  const matches = records.filter(
    (r) => r.effectiveFrom <= on && (r.effectiveTo === null || on <= r.effectiveTo),
  )
  if (matches.length === 0) return null
  // Overlapping windows are a data defect the governance workflow should
  // prevent, but if one slips through, the most recently opened window wins.
  return matches.reduce((a, b) => (a.effectiveFrom >= b.effectiveFrom ? a : b))
}
```

Append to `packages/kernel/src/index.ts`:

```typescript
export { resolveEffective } from './effective-date'
export type { EffectiveRecord } from './effective-date'
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm jest packages/kernel/src/effective-date.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing test for the health controller**

`services/svc-config/src/health.controller.test.ts`:

```typescript
import { HealthController } from './health.controller'

describe('HealthController', () => {
  it('reports ok when the database answers', async () => {
    const repo = { ping: jest.fn().mockResolvedValue(true) }
    const result = await new HealthController(repo as never).health()
    expect(result.status).toBe('ok')
    expect(result.service).toBe('svc-config')
    expect(result.dependencies).toEqual({ db: 'up' })
  })

  it('reports degraded when the database throws', async () => {
    const repo = { ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    const result = await new HealthController(repo as never).health()
    expect(result.status).toBe('degraded')
    expect(result.dependencies).toEqual({ db: 'down' })
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm jest services/svc-config`
Expected: FAIL — `Cannot find module './health.controller'`

- [ ] **Step 7: Scaffold the service and implement the controllers**

`services/svc-config/package.json`:

```json
{
  "name": "@gadong/svc-config",
  "version": "0.0.0",
  "private": true,
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -b",
    "start": "node dist/main.js",
    "migrate": "node-pg-migrate -m migrations up"
  },
  "dependencies": {
    "@gadong/kernel": "workspace:*",
    "@nestjs/common": "^10.4.4",
    "@nestjs/core": "^10.4.4",
    "@nestjs/platform-express": "^10.4.4",
    "node-pg-migrate": "^7.6.1",
    "pg": "^8.13.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": { "@types/pg": "^8.11.10" }
}
```

`services/svc-config/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "../../packages/kernel" }]
}
```

`services/svc-config/src/rules.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common'
import { Pool } from 'pg'
import type { EffectiveRecord } from '@gadong/kernel'

export interface StatutoryRule extends EffectiveRecord {
  ruleKey: string
  value: unknown
  unit: string
  citation: string
  governanceClass: string
}

@Injectable()
export class RulesRepository {
  private readonly pool = new Pool({ connectionString: process.env.DATABASE_URL })

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1')
    return true
  }

  async findByKey(ruleKey: string): Promise<StatutoryRule[]> {
    const { rows } = await this.pool.query(
      `SELECT rule_key, value, unit, citation, governance_class,
              to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
              to_char(effective_to,   'YYYY-MM-DD') AS effective_to
         FROM config.statutory_rule
        WHERE rule_key = $1 AND status = 'active'`,
      [ruleKey],
    )
    return rows.map((r) => ({
      ruleKey: r.rule_key,
      value: r.value,
      unit: r.unit,
      citation: r.citation,
      governanceClass: r.governance_class,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    }))
  }
}
```

`services/svc-config/src/health.controller.ts`:

```typescript
import { Controller, Get } from '@nestjs/common'
import { buildHealth, type HealthPayload } from '@gadong/kernel'
import { RulesRepository } from './rules.repository'

@Controller('health')
export class HealthController {
  constructor(private readonly repo: RulesRepository) {}

  @Get()
  async health(): Promise<HealthPayload> {
    let db: 'up' | 'down' = 'down'
    try {
      await this.repo.ping()
      db = 'up'
    } catch {
      db = 'down'
    }
    return buildHealth('svc-config', { db })
  }
}
```

`services/svc-config/src/rules.controller.ts`:

```typescript
import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common'
import { resolveEffective } from '@gadong/kernel'
import { RulesRepository, type StatutoryRule } from './rules.repository'

@Controller('rules')
export class RulesController {
  constructor(private readonly repo: RulesRepository) {}

  @Get(':key')
  async byKey(@Param('key') key: string, @Query('on') on?: string): Promise<StatutoryRule> {
    const asOf = on ?? new Date().toISOString().slice(0, 10)
    const resolved = resolveEffective(await this.repo.findByKey(key), asOf)
    if (!resolved) {
      throw new NotFoundException({ code: 'CFG-404', message_i18n_key: 'config.rule.not_effective' })
    }
    return resolved
  }
}
```

`services/svc-config/src/app.module.ts`:

```typescript
import { Module } from '@nestjs/common'
import { HealthController } from './health.controller'
import { RulesController } from './rules.controller'
import { RulesRepository } from './rules.repository'

@Module({
  controllers: [HealthController, RulesController],
  providers: [RulesRepository],
})
export class AppModule {}
```

`services/svc-config/src/main.ts`:

```typescript
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  // 0.0.0.0 so the compose healthcheck and sibling containers can reach it;
  // the port is never published beyond loopback on 165 (see Task 5).
  await app.listen(3000, '0.0.0.0')
}

void bootstrap()
```

`services/svc-config/migrations/1690000000000_statutory-rule.js`:

```javascript
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createSchema('config', { ifNotExists: true })
  pgm.createTable(
    { schema: 'config', name: 'statutory_rule' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      rule_key: { type: 'text', notNull: true },
      value: { type: 'jsonb', notNull: true },
      unit: { type: 'text', notNull: true },
      statutory_floor: { type: 'jsonb' },
      statutory_ceiling: { type: 'jsonb' },
      citation: { type: 'text', notNull: true },
      effective_from: { type: 'date', notNull: true },
      effective_to: { type: 'date' },
      governance_class: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'active' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  // Statutory Spec §1: unique on (rule_key, effective_from).
  pgm.addConstraint({ schema: 'config', name: 'statutory_rule' }, 'statutory_rule_key_from_uk', {
    unique: ['rule_key', 'effective_from'],
  })
}

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'config', name: 'statutory_rule' })
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm install && pnpm jest services/svc-config`
Expected: PASS, 2 tests.

- [ ] **Step 9: Verify the whole suite and typecheck still pass**

Run: `pnpm typecheck && pnpm test`
Expected: all green, 13 tests total.

- [ ] **Step 10: Commit**

```bash
git add packages/kernel services/svc-config pnpm-lock.yaml
git commit -m "feat(svc-config): health endpoint and effective-dated rule resolution"
```

---

## Task 4: Build images in CI and publish to GHCR

**Files:**
- Create: `services/svc-config/Dockerfile`, `web/Dockerfile`, `web/index.html`, `web/nginx.conf`
- Create: `.dockerignore`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `verify` job from Task 1; `services/svc-config` from Task 3.
- Produces: images `ghcr.io/mavrone81/gadonghr-svc-config:<sha>` and `ghcr.io/mavrone81/gadonghr-web:<sha>`, both also tagged `:main`. A git ref `refs/ci-pass/<sha>` written only after publish succeeds. Task 5 consumes the image names; Task 7 consumes the `ci-pass` ref.

- [ ] **Step 1: Add the service Dockerfile**

`services/svc-config/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/kernel/package.json packages/kernel/
COPY services/svc-config/package.json services/svc-config/
RUN pnpm install --frozen-lockfile
COPY packages/kernel packages/kernel
COPY services/svc-config services/svc-config
RUN pnpm --filter @gadong/svc-config build
RUN pnpm deploy --filter @gadong/svc-config --prod /out

FROM node:22-alpine AS runtime
ARG GADONG_BUILD_SHA=dev
ENV GADONG_BUILD_SHA=$GADONG_BUILD_SHA NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# Alpine's node image ships an unprivileged `node` user; Security doc §6
# requires non-root containers.
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

`.dockerignore` at repo root:

```
node_modules
**/node_modules
**/dist
**/coverage
.git
docs
```

- [ ] **Step 2: Add a placeholder web image**

Phase 0 needs *something* to answer at `https://hr.bevorasg.com/` so the vhost, the certificate, and the deploy loop can all be proven before the PWA exists (ADR-008).

`web/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>GaDongHR</title>
<h1>GaDongHR</h1>
<p>Phase 0 walking skeleton. The PWA lands in Phase A.</p>
<p>API health: <a href="/api/config/health">/api/config/health</a></p>
```

`web/nginx.conf`:

```nginx
server {
    listen 8080;
    root /usr/share/nginx/html;
    location = /healthz { return 200 "ok\n"; add_header Content-Type text/plain; }
    location / { try_files $uri $uri/ /index.html; }
}
```

`web/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
EXPOSE 8080
```

- [ ] **Step 3: Extend CI to build, push, and mark**

Replace `.github/workflows/ci.yml` with:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: write
  packages: write

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test -- --ci

  images:
    needs: verify
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - name: svc-config
            context: .
            dockerfile: services/svc-config/Dockerfile
          - name: web
            context: web
            dockerfile: web/Dockerfile
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: ${{ matrix.context }}
          file: ${{ matrix.dockerfile }}
          push: true
          build-args: GADONG_BUILD_SHA=${{ github.sha }}
          tags: |
            ghcr.io/mavrone81/gadonghr-${{ matrix.name }}:${{ github.sha }}
            ghcr.io/mavrone81/gadonghr-${{ matrix.name }}:main
          cache-from: type=gha
          cache-to: type=gha,mode=max

  mark-ci-pass:
    needs: images
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # The server's deploy script refuses to act on a commit without this ref.
      # It is written LAST, so its existence means every gate above passed AND
      # the images the server is about to pull actually exist in the registry.
      - run: git push origin HEAD:refs/ci-pass/${{ github.sha }}
```

- [ ] **Step 4: Verify the build locally before pushing**

Run: `docker build -f services/svc-config/Dockerfile --build-arg GADONG_BUILD_SHA=localtest -t gadonghr-svc-config:localtest .`
Expected: build succeeds.

Run: `docker run --rm -e DATABASE_URL=postgres://nobody@127.0.0.1:1/none -p 13999:3000 -d --name cfgtest gadonghr-svc-config:localtest && sleep 5 && curl -s localhost:13999/health; docker rm -f cfgtest`
Expected: `{"status":"degraded","service":"svc-config","version":"localtest","dependencies":{"db":"down"}}` — degraded is correct here, there is no database. It proves the image boots and the build stamp is injected.

- [ ] **Step 5: Commit and confirm the images publish**

```bash
git add .dockerignore web services/svc-config/Dockerfile .github/workflows/ci.yml
git commit -m "ci: build svc-config and web images, publish to GHCR, write ci-pass marker"
git push
```

Verify: `gh run watch`, then
`git ls-remote origin "refs/ci-pass/*"` — expected: one ref matching the pushed sha.
`docker manifest inspect ghcr.io/mavrone81/gadonghr-svc-config:main` — expected: a manifest, not `denied`.

If the package is private, make both packages public in GitHub → Packages → Package settings, or Task 7 must add a `docker login ghcr.io` on the server. Prefer public: the box has no GHCR credentials today.

---

## Task 5: Port-safe compose overlay for droplet 165

**This is the task that keeps GaDongHR from taking the box down.** Read the Global Constraints and the Capacity Finding before starting.

**Files:**
- Create: `deploy/docker-compose.165.yml`
- Create: `deploy/vault/vault.hcl`
- Create: `deploy/postgres/init/01-roles.sql`
- Create: `deploy/scripts/preflight-ports.sh`
- Test: `deploy/scripts/preflight-ports.test.sh`
- Modify: `deploy/.env.example`

**Interfaces:**
- Consumes: GHCR image names from Task 4.
- Produces: an overlay applied as
  `docker compose -f docker-compose.yml -f docker-compose.165.yml --profile core ...`
  publishing exactly `127.0.0.1:21000` (web), `127.0.0.1:21001` (keycloak), `127.0.0.1:21020` (svc-config). Task 6's nginx vhost and Task 7's deploy script both consume this file list and these ports.

- [ ] **Step 1: Write the failing test for the port preflight**

`deploy/scripts/preflight-ports.test.sh`:

```bash
#!/usr/bin/env bash
# Run: bash deploy/scripts/preflight-ports.test.sh
set -uo pipefail
SCRIPT="$(dirname "$0")/preflight-ports.sh"
fails=0

check() { # check <label> <expected-exit> <actual-exit>
  if [ "$2" -eq "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (want $2, got $3)"; fails=$((fails+1)); fi
}

# A port nothing is listening on must pass.
bash "$SCRIPT" 21000 21001 21020 >/dev/null 2>&1
check "free ports pass" 0 $?

# A port that IS listening must fail. Hold 21000 open for the duration.
python3 -c "
import socket,time,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(('127.0.0.1',21000)); s.listen(1); sys.stderr.write('ready\n'); time.sleep(5)
" 2>/dev/null &
holder=$!
sleep 1
bash "$SCRIPT" 21000 >/dev/null 2>&1
check "occupied port fails" 1 $?
kill "$holder" 2>/dev/null || true

# 80 and 443 are the box's nginx. Naming them must always fail, free or not.
bash "$SCRIPT" 443 >/dev/null 2>&1
check "reserved host port 443 fails" 1 $?

[ "$fails" -eq 0 ] && echo "PASS" || { echo "$fails failure(s)"; exit 1; }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash deploy/scripts/preflight-ports.test.sh`
Expected: FAIL — `preflight-ports.sh: No such file or directory`, non-zero exit.

- [ ] **Step 3: Implement the preflight script**

`deploy/scripts/preflight-ports.sh`:

```bash
#!/usr/bin/env bash
# Refuse to start the stack if any port it wants is already taken.
#
# Box 165 runs 68 containers across 20 compose projects and a host nginx that
# owns :80 and :443 for 28 vhosts. A port collision here does not fail politely
# — it either fails the whole `compose up` or, worse, steals traffic from
# another tenant's production app.
#
# Usage: preflight-ports.sh 21000 21001 21020
set -euo pipefail

# Host nginx owns these. No GaDongHR container may ever bind them, even if a
# check happens to run while nginx is down.
NEVER_BIND=(80 443 22)

fail=0
for port in "$@"; do
  for reserved in "${NEVER_BIND[@]}"; do
    if [ "$port" = "$reserved" ]; then
      echo "REFUSE: port $port belongs to the host (nginx/sshd) and must never be published" >&2
      fail=1
      continue 2
    fi
  done
  if ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then
    echo "CONFLICT: port $port is already in use:" >&2
    ss -ltnp "sport = :$port" 2>/dev/null | tail -n +2 >&2
    fail=1
  fi
done

[ "$fail" -eq 0 ] || { echo "preflight failed — not deploying" >&2; exit 1; }
echo "preflight ok: $* are free"
```

Make executable: `chmod +x deploy/scripts/preflight-ports.sh`

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash deploy/scripts/preflight-ports.test.sh`
Expected: `ok` on all three checks, then `PASS`.

- [ ] **Step 5: Write the overlay**

`deploy/docker-compose.165.yml`:

```yaml
# GaDongHR — droplet 165 (165.22.246.45) overlay.
#
# Apply as:
#   docker compose -f docker-compose.yml -f docker-compose.165.yml --profile core ...
#
# WHY THIS FILE EXISTS
# --------------------
# The base docker-compose.yml is the standalone/customer artifact from ADR-001:
# Traefik owns :80 and :443 and terminates TLS with Let's Encrypt. That is
# correct for a dedicated host and WRONG for 165, where a host nginx already
# owns both ports for 28 vhosts across 20 compose projects. Publishing :80 there
# would fail to bind at best and hijack another tenant's production traffic at
# worst.
#
# So on 165: Traefik is disabled, the host nginx does the routing (exactly as it
# does for sign/ims/form/bill/crm.bevorasg.com), and every port this stack
# publishes is loopback-scoped inside the reserved 21000-21029 block.
#
# Images are PULLED, never built. An on-box `docker compose build` panicked
# dockerd inside BuildKit on 2026-07-29 and killed all 61 containers on this box
# for five hours. CI builds; the server pulls. No exceptions.

name: gadonghr

services:
  # Traefik moved to a profile that no deploy command ever selects. `profiles`
  # is replaced (not merged) by the overlay, so this removes it from
  # `--profile core` cleanly without deleting it from the base file.
  traefik:
    profiles: ["standalone-only"]

  postgres:
    mem_limit: 512m
    # Not published at all. Reach it with:
    #   docker compose -p gadonghr exec postgres psql -U "$POSTGRES_SUPERUSER"
    # Publishing a database on a shared box is how mmtest-db ended up reachable
    # on 0.0.0.0:5433.
    environment:
      # 01-roles.sql reads :'db_password_config' from this, so the secret stays
      # out of the SQL file, which is committed.
      PSQL_OPTIONS: "-v db_password_config=${DB_PASSWORD_CONFIG}"

  vault:
    mem_limit: 192m

  svc-crypto:
    image: ghcr.io/mavrone81/gadonghr-svc-crypto:${GADONG_VERSION:-main}
    mem_limit: 256m

  svc-config:
    image: ghcr.io/mavrone81/gadonghr-svc-config:${GADONG_VERSION:-main}
    mem_limit: 256m
    ports:
      - "127.0.0.1:21020:3000"
    environment:
      DATABASE_URL: postgres://config:${DB_PASSWORD_CONFIG}@postgres:5432/${POSTGRES_DB}?options=-csearch_path%3Dconfig

  keycloak:
    mem_limit: 768m
    ports:
      - "127.0.0.1:21001:8080"
    # TLS terminates at the host nginx, which forwards X-Forwarded-Proto. The
    # base command already sets --proxy-headers=xforwarded, so Keycloak builds
    # https:// callback URLs correctly from behind nginx.
    labels: []

  web:
    image: ghcr.io/mavrone81/gadonghr-web:${GADONG_VERSION:-main}
    mem_limit: 64m
    ports:
      - "127.0.0.1:21000:8080"
    labels: []
    # The base file makes every service depend on postgres+rabbitmq+svc-crypto.
    # The static Phase 0 web image needs none of them, and that dependency chain
    # would keep the one thing nginx fronts down until the whole stack is up.
    depends_on: !reset []

  # ---- Not deployed in Phase 0 (see the Capacity Finding) ----
  # 4 vCPU / 2 GB available RAM cannot host the full core profile, which the
  # architecture sizes at 8 vCPU / 16 GB. These are parked on an unselected
  # profile so a stray `--profile core` cannot start them by accident.
  rabbitmq:            { profiles: ["phase-a"] }
  redis:               { profiles: ["phase-a"] }
  minio:               { profiles: ["phase-a"] }
  clamav:              { profiles: ["phase-a"] }
  retention-job:       { profiles: ["phase-a"] }
  compreface-postgres: { profiles: ["phase-b"] }
  compreface-api:      { profiles: ["phase-b"] }
  compreface-core:     { profiles: ["phase-b"] }
  svc-authz:           { profiles: ["phase-a"] }
  svc-i18n:            { profiles: ["phase-a"] }
  svc-notify:          { profiles: ["phase-a"] }
  svc-docs:            { profiles: ["phase-a"] }
  svc-audit:           { profiles: ["phase-a"] }
  svc-onboarding:      { profiles: ["phase-a"] }
  svc-scheduler:       { profiles: ["phase-b"] }
  svc-timesheet:       { profiles: ["phase-b"] }
  svc-attendance:      { profiles: ["phase-b"] }
  svc-leave:           { profiles: ["phase-c"] }
  svc-claims:          { profiles: ["phase-c"] }
  svc-payroll:         { profiles: ["phase-d"] }

networks:
  internal:
    name: gadong-internal
    ipam:
      config:
        # 172.17.0.0/16 .. 172.31.0.0/16 are ALL allocated on this box, and
        # 192.168.0.0/20 .. 192.168.112.0/20 are taken by the existing 20
        # stacks. 192.168.128.0/20 is the next free block. Pinned, because an
        # auto-allocation failure here surfaces as an unrelated stack losing
        # its network on the next daemon restart.
        - subnet: 192.168.128.0/20
```

- [ ] **Step 6: Add the two files the base compose already references but that do not exist**

`deploy/vault/vault.hcl`:

```hcl
# Vault for GaDongHR (ADR-004). Integrated raft storage on the vault_data
# volume; TLS is not terminated here because Vault is only reachable on the
# internal compose network and only by svc-crypto.
#
# Auto-unseal is deliberately NOT configured: the Operations Runbook §2 key
# ceremony issues 5 Shamir shares with threshold 3 to named officers. After a
# host reboot Vault starts SEALED and sensitive-field operations return 503 by
# design. Loss of 3+ shares is permanent data loss.
ui = false
disable_mlock = false

storage "raft" {
  path    = "/vault/data"
  node_id = "gadong-vault-1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr     = "http://vault:8200"
cluster_addr = "http://vault:8201"

# Shipped to svc-audit (Security doc §3.3).
audit {
  file {
    file_path = "/vault/data/audit.log"
  }
}
```

`deploy/postgres/init/01-roles.sql`:

```sql
-- Schema-per-service roles (ADR-003). Runs once, on first initialisation of an
-- empty pg_data volume.
--
-- Each service gets a role that can reach ONLY its own schema. This is what
-- makes "no cross-service table access" an enforced constraint rather than a
-- convention, and it is what lets any schema move to its own instance later
-- without a code change.
--
-- Passwords come from the environment; postgres:16's entrypoint runs *.sql
-- files through psql with these already exported.

\set ON_ERROR_STOP on

-- gen_random_uuid() for the migrations.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS config;
CREATE ROLE config LOGIN PASSWORD :'db_password_config';
GRANT USAGE, CREATE ON SCHEMA config TO config;
ALTER ROLE config SET search_path TO config;
-- A runaway service must not be able to exhaust connections for the other
-- schemas sharing this instance (ADR-003 consequences).
ALTER ROLE config CONNECTION LIMIT 20;
ALTER ROLE config SET statement_timeout TO '30s';

REVOKE ALL ON SCHEMA public FROM PUBLIC;
```

The `PSQL_OPTIONS` variable that feeds `:'db_password_config'` into this file is already set on the `postgres` service in Step 5's overlay.

> **Verify this path works before relying on it.** `PSQL_OPTIONS` is honoured by the `postgres:16` entrypoint, but confirm it in Step 8 with a throwaway volume. If the variable does not reach the init scripts, use the templating fallback instead: rename the file to `01-roles.sql.template`, drop the `PSQL_OPTIONS` line, and add `deploy/postgres/init/00-render.sh`:
>
> ```bash
> #!/usr/bin/env bash
> set -euo pipefail
> export db_password_config="$DB_PASSWORD_CONFIG"
> envsubst < /docker-entrypoint-initdb.d/01-roles.sql.template \
>   | psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
> ```
>
> with `DB_PASSWORD_CONFIG: ${DB_PASSWORD_CONFIG}` added to the `postgres` service environment and `\set`/`:'…'` replaced by `${db_password_config}` in the template.

- [ ] **Step 7: Add the overlay variables to `.env.example`**

Append to `deploy/.env.example`:

```bash
# ---------- Droplet 165 overlay (docker-compose.165.yml) ----------
# PUBLIC_HOST is hr.bevorasg.com; TLS terminates at the HOST nginx, not Traefik.
# GADONG_VERSION is set to the deployed git sha by auto-deploy-gadonghr.sh —
# leave it as `main` for manual runs.
GADONG_VERSION=main
```

And change the existing `PUBLIC_HOST` / `ACME_EMAIL` comment block to note that `ACME_EMAIL` is unused on 165 (certbot on the host owns certificates there).

- [ ] **Step 8: Validate the merged config without starting anything**

Run from `deploy/`:

```bash
cp .env.example .env.validate
sed -i '' 's/CHANGE_ME/validationonly/g; s/hr\.example\.co\.th/hr.bevorasg.com/' .env.validate
docker compose --env-file .env.validate -f docker-compose.yml -f docker-compose.165.yml --profile core config > /tmp/gadong-165-merged.yml
```

Then assert the three things that matter:

```bash
# 1. No service publishes 80, 443, or any non-loopback port.
! grep -E 'published: "(80|443)"' /tmp/gadong-165-merged.yml && echo "ok: 80/443 not published"
grep -A2 'published:' /tmp/gadong-165-merged.yml | grep -c 'host_ip: 127.0.0.1'   # expect 3

# 2. Traefik is not in the core profile.
docker compose --env-file .env.validate -f docker-compose.yml -f docker-compose.165.yml --profile core config --services | grep -qx traefik && echo "FAIL: traefik still selected" || echo "ok: traefik excluded"

# 3. The subnet is pinned.
grep -q '192.168.128.0/20' /tmp/gadong-165-merged.yml && echo "ok: subnet pinned"
```

Expected: `ok: 80/443 not published`, `3`, `ok: traefik excluded`, `ok: subnet pinned`.

Clean up: `rm .env.validate`

- [ ] **Step 9: Commit**

```bash
git add deploy/docker-compose.165.yml deploy/vault deploy/postgres deploy/scripts deploy/.env.example
git commit -m "feat(deploy): port-safe droplet-165 overlay, vault config, pg role init, port preflight"
```

---

## Task 6: nginx vhost and TLS for hr.bevorasg.com

**Files:**
- Create: `deploy/nginx/hr.bevorasg.com.conf` (canonical copy in the repo)
- Installed on 165 as `/etc/nginx/sites-available/hr.bevorasg.com.conf`

**Interfaces:**
- Consumes: loopback ports 21000 / 21001 / 21020 from Task 5.
- Produces: `https://hr.bevorasg.com/` → web, `/auth/` → Keycloak, `/api/config/` → svc-config. Task 8 verifies through this vhost.

- [ ] **Step 1: Write the vhost**

`deploy/nginx/hr.bevorasg.com.conf`:

```nginx
# GaDongHR — host nginx vhost on box 165 (hr.bevorasg.com).
#
# Install:
#   scp deploy/nginx/hr.bevorasg.com.conf \
#       root@165.22.246.45:/etc/nginx/sites-available/hr.bevorasg.com.conf
#   ssh root@165.22.246.45 'ln -sf /etc/nginx/sites-available/hr.bevorasg.com.conf \
#       /etc/nginx/sites-enabled/hr.bevorasg.com.conf && nginx -t && systemctl reload nginx'
#   ssh root@165.22.246.45 'certbot --nginx -d hr.bevorasg.com'
#
# Certbot rewrites this file in place to add the listen 443 / ssl_certificate
# lines and the :80 redirect, exactly as it has for sign/ims/form/bill/crm.
#
# THIS BOX FRONTS ~28 VHOSTS ACROSS 20 COMPOSE PROJECTS. `nginx -t` before
# every reload, and never touch a server block you did not add. A config that
# is correct on disk but not reloaded has bitten this box before.

server {
    listen 80;
    listen [::]:80;
    server_name hr.bevorasg.com;

    # Receipts, medical certificates and ID scans (M1-2, M6-2). The default 1m
    # would reject a phone photo of an ID card.
    client_max_body_size 25m;

    # Keycloak. Must come before `location /` — nginx prefix matching would
    # otherwise hand /auth to the PWA.
    location /auth/ {
        proxy_pass         http://127.0.0.1:21001/auth/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        # Keycloak derives issuer and redirect URIs from these. Get X-Forwarded-
        # Proto wrong and OIDC login silently loops on a redirect.
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-Host  $host;
        proxy_set_header   X-Forwarded-Port  443;
    }

    location /api/config/ {
        proxy_pass         http://127.0.0.1:21020/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location / {
        proxy_pass         http://127.0.0.1:21000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
    }
}
```

- [ ] **Step 2: Confirm DNS before touching nginx**

Run: `dig +short hr.bevorasg.com A @ns1.digitalocean.com`
Expected: `165.22.246.45`. (Verified present 2026-08-02; there is no wildcard on this zone, so this is a real record.) If it is empty, stop — certbot's HTTP-01 challenge will fail and burn a rate-limit attempt.

- [ ] **Step 3: Install the vhost**

```bash
scp deploy/nginx/hr.bevorasg.com.conf root@165.22.246.45:/etc/nginx/sites-available/hr.bevorasg.com.conf
ssh root@165.22.246.45 'ln -sf /etc/nginx/sites-available/hr.bevorasg.com.conf /etc/nginx/sites-enabled/hr.bevorasg.com.conf && nginx -t'
```

Expected: `syntax is ok` / `test is successful`.
If `nginx -t` fails, **do not reload** — the other 27 vhosts are live. Fix and re-test.

- [ ] **Step 4: Reload and issue the certificate**

```bash
ssh root@165.22.246.45 'systemctl reload nginx'
ssh root@165.22.246.45 'certbot --nginx -d hr.bevorasg.com --non-interactive --agree-tos -m samuel@vorkhive.com'
ssh root@165.22.246.45 'nginx -t && systemctl reload nginx'
```

- [ ] **Step 5: Verify TLS**

Run: `curl -sSI https://hr.bevorasg.com/ | head -1`
Expected: a real HTTP status with **no certificate error**. `502 Bad Gateway` is the correct answer here — the certificate is valid and nginx is proxying, but nothing is listening on 21000 yet. That is Task 8.

Run: `echo | openssl s_client -connect hr.bevorasg.com:443 -servername hr.bevorasg.com 2>/dev/null | openssl x509 -noout -issuer -dates`
Expected: issuer `Let's Encrypt`, not the box's self-signed catch-all.

- [ ] **Step 6: Commit**

```bash
git add deploy/nginx
git commit -m "feat(deploy): host nginx vhost for hr.bevorasg.com"
```

---

## Task 7: Pull-deploy script, CI gate, and the image-leak guard

**Files:**
- Create: `deploy/scripts/auto-deploy-gadonghr.sh`
- Create: `deploy/scripts/prune-gadonghr-images.sh`
- Installed on 165 as `/root/auto-deploy-gadonghr.sh` and `/root/prune-gadonghr-images.sh`

**Interfaces:**
- Consumes: `refs/ci-pass/<sha>` from Task 4; the file list and ports from Task 5.
- Produces: `/var/log/gadonghr-deploy.log` ending each successful run with `=== Deploy OK: <sha> ===`; state in `/var/lib/gadonghr/last-deployed.sha`.

- [ ] **Step 1: Write the deploy script**

`deploy/scripts/auto-deploy-gadonghr.sh`:

```bash
#!/usr/bin/env bash
# Pull-based auto-deploy for GaDongHR on box 165.22.246.45.
#
# Install (once, as root on the box):
#   cp /root/GaDongHR/deploy/scripts/auto-deploy-gadonghr.sh /root/
#   chmod +x /root/auto-deploy-gadonghr.sh
#   crontab -e  ->  * * * * * flock -n /tmp/gadonghr-deploy.lock /root/auto-deploy-gadonghr.sh >> /var/log/gadonghr-deploy.log 2>&1
#
# THIS BOX IS MULTI-TENANT — 20 compose stacks including other developers'
# production. Every docker command below is scoped to project `gadonghr`.
# Never `down`, never `down -v`, never a bare `docker system prune`.
#
# It PULLS images. It never builds. An on-box BuildKit build panicked dockerd
# on 2026-07-29 and killed all 61 containers for five hours.
#
# Two failure modes are designed against, both learned on this box:
#   1. A deploy that fails partway leaves the stack DOWN, and a naive
#      "has the sha changed?" check then skips forever because the checkout
#      already fast-forwarded. So this asks TWO independent questions —
#      "is there new code?" AND "is the app actually running?" — and deploys
#      if either says yes. That is what makes it self-healing.
#   2. `git pull` on a dirty checkout wedges. This uses `reset --hard`; the
#      server checkout is not an editing surface.
#
# The ONLY proof a deploy worked is the `=== Deploy OK: <sha> ===` line.
# HEAD and running images both look correct while a deploy is failing.
set -euo pipefail

REPO_DIR="/root/GaDongHR"
BRANCH="main"
PROJECT="gadonghr"
PROBE_CONTAINER="gadonghr-web-1"
STATE_DIR="/var/lib/gadonghr"
LAST_DEPLOYED_FILE="$STATE_DIR/last-deployed.sha"

COMPOSE=(docker compose
  --project-directory "$REPO_DIR/deploy"
  -f "$REPO_DIR/deploy/docker-compose.yml"
  -f "$REPO_DIR/deploy/docker-compose.165.yml"
  --env-file "$REPO_DIR/deploy/.env"
  --profile core)

ts()  { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "$(ts)  $*"; }

mkdir -p "$STATE_DIR"
cd "$REPO_DIR" || { log "FATAL repo missing at $REPO_DIR"; exit 1; }

git fetch --quiet origin "$BRANCH" || { log "fetch failed"; exit 1; }
# CI writes refs/ci-pass/<sha> only after typecheck, tests, AND the image push
# have all succeeded. Its presence means the images this script is about to
# pull actually exist in GHCR.
git fetch --quiet --prune origin "+refs/ci-pass/*:refs/ci-pass/*" || true

REMOTE=$(git rev-parse "origin/$BRANCH")
LAST_DEPLOYED=""
[ -f "$LAST_DEPLOYED_FILE" ] && LAST_DEPLOYED=$(cat "$LAST_DEPLOYED_FILE")

# Question 2, asked independently of the sha: is the stack actually up?
RUNNING=$(docker inspect -f '{{.State.Running}}' "$PROBE_CONTAINER" 2>/dev/null || true)

if [ "$REMOTE" = "$LAST_DEPLOYED" ] && [ "$RUNNING" = "true" ]; then
  exit 0   # nothing new, stack healthy — the common case, stays quiet
fi

if ! git rev-parse --verify --quiet "refs/ci-pass/$REMOTE" >/dev/null; then
  log "waiting: $REMOTE has no ci-pass marker yet"
  exit 0
fi

log "=== Deploying $REMOTE (last=$LAST_DEPLOYED running=$RUNNING) ==="

git reset --hard "$REMOTE" --quiet

# Refuse to proceed if something else grabbed our ports since the last deploy.
"$REPO_DIR/deploy/scripts/preflight-ports.sh" 21000 21001 21020 || {
  log "FATAL port preflight failed"; exit 1; }

# Disk guard. >85% is act-now on this box; a deploy that fills the disk takes
# all 20 stacks down, not just this one.
USED=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$USED" -ge 90 ]; then
  log "FATAL disk at ${USED}% — refusing to pull images"; exit 1
fi

export GADONG_VERSION="$REMOTE"

"${COMPOSE[@]}" pull --quiet
"${COMPOSE[@]}" up -d --remove-orphans

# Wait for the thing nginx actually fronts.
for i in $(seq 1 30); do
  if curl -fsS -m 5 http://127.0.0.1:21000/healthz >/dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 30 ] && { log "FATAL web did not become healthy in 60s"; exit 1; }
  sleep 2
done

# And confirm the API answers with the sha we just deployed — this is what
# distinguishes "containers started" from "the new code is live".
LIVE_SHA=$(curl -fsS -m 5 http://127.0.0.1:21020/health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
if [ "$LIVE_SHA" != "$REMOTE" ]; then
  log "FATAL svc-config reports version=$LIVE_SHA, expected $REMOTE"; exit 1
fi

echo "$REMOTE" > "$LAST_DEPLOYED_FILE"
log "=== Deploy OK: $REMOTE ==="
```

- [ ] **Step 2: Write the image-leak guard**

`deploy/scripts/prune-gadonghr-images.sh`:

```bash
#!/usr/bin/env bash
# Keep only the newest N GaDongHR images per repo.
#
# WHY THIS IS NOT OPTIONAL. CI SHA-tags every image. `docker system prune -f`
# removes only DANGLING images, and a tagged image is never dangling — so
# SHA-tagged images accumulate forever, invisibly. This is exactly the leak
# that cost ~3 GB per deploy on this box before it was found on 2026-07-31.
# GaDongHR is the second stack here to SHA-tag; it ships its own cleanup.
#
# Install: cp to /root/, chmod +x, cron:
#   20 20 * * * /root/prune-gadonghr-images.sh >> /var/log/docker-prune.log 2>&1
#
# NEVER widen this to `docker image prune -a`. 165 is multi-tenant across two
# companies and at least one outside developer; that would delete their
# rollback images. `docker rmi` is called WITHOUT -f so an in-use image is
# refused rather than yanked out from under a running container.
set -euo pipefail
KEEP="${KEEP:-4}"

for repo in $(docker images --format '{{.Repository}}' \
              | grep '^ghcr\.io/mavrone81/gadonghr-' | sort -u); do
  docker images "$repo" --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' \
    | grep -v ':main$' \
    | sort -r \
    | tail -n +$((KEEP + 1)) \
    | cut -f2 \
    | while read -r tag; do
        echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ')  rmi $tag"
        docker rmi "$tag" || true
      done
done
```

- [ ] **Step 3: Test both scripts locally before installing**

Run: `bash -n deploy/scripts/auto-deploy-gadonghr.sh && bash -n deploy/scripts/prune-gadonghr-images.sh && echo "syntax ok"`
Expected: `syntax ok`

Run: `shellcheck deploy/scripts/*.sh` (if available)
Expected: no errors (warnings acceptable).

- [ ] **Step 4: Commit**

```bash
chmod +x deploy/scripts/auto-deploy-gadonghr.sh deploy/scripts/prune-gadonghr-images.sh
git add deploy/scripts
git commit -m "feat(deploy): CI-gated self-healing pull-deploy and scoped image prune for 165"
git push
```

---

## Task 8: First live deployment and end-to-end verification

**Files:** none created — this task installs and proves what Tasks 1–7 built.

**Interfaces:**
- Consumes: everything above.
- Produces: a live `https://hr.bevorasg.com` and a verified push-to-live loop.

- [ ] **Step 1: Check the box before touching it**

```bash
ssh root@165.22.246.45 'df -h / | tail -1; free -m | head -2; uptime; docker ps -q | wc -l'
```

Expected: disk **< 85%**, and note the running-container count as a baseline (68 on 2026-08-02). **If disk ≥ 85%, stop and reclaim first** — see `droplet-165-disk-pressure` in memory. A full disk on this box takes down all 20 stacks.

- [ ] **Step 2: Clone the repo and write the real `.env`**

```bash
ssh root@165.22.246.45 'git clone https://github.com/Mavrone81/GaDongHR /root/GaDongHR && cd /root/GaDongHR/deploy && cp .env.example .env && chmod 600 .env'
```

Then fill every `CHANGE_ME` **on the server only** — never in the repo, never pasted into chat:

```bash
ssh root@165.22.246.45 'cd /root/GaDongHR/deploy && \
  sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=hr.bevorasg.com|; s|^GADONG_VERSION=.*|GADONG_VERSION=main|" .env && \
  while IFS= read -r line; do :; done < /dev/null && \
  for k in POSTGRES_SUPERPASSWORD DB_PASSWORD_CONFIG KC_DB_PASSWORD KC_ADMIN_PASSWORD RABBITMQ_PASSWORD REDIS_PASSWORD MINIO_ROOT_PASSWORD CF_DB_PASSWORD GRAFANA_ADMIN_PASSWORD; do \
    sed -i "s|^${k}=CHANGE_ME$|${k}=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)|" .env; done && \
  grep -c CHANGE_ME .env'
```

Expected: the remaining `CHANGE_ME` count covers only `VAULT_APPROLE_ID` (set by the Vault ceremony) and the DB passwords for services not deployed in Phase 0.

- [ ] **Step 3: Run the port preflight against the live box**

```bash
ssh root@165.22.246.45 '/root/GaDongHR/deploy/scripts/preflight-ports.sh 21000 21001 21020'
```

Expected: `preflight ok: 21000 21001 21020 are free`
If it reports a conflict, **stop** — pick the next free ports from the 21000–21029 block, update `docker-compose.165.yml`, the nginx vhost, and the deploy script together, then re-run.

- [ ] **Step 4: First manual `up` (before enabling cron)**

```bash
ssh root@165.22.246.45 'cd /root/GaDongHR/deploy && \
  docker compose -f docker-compose.yml -f docker-compose.165.yml --env-file .env --profile core pull --quiet && \
  docker compose -f docker-compose.yml -f docker-compose.165.yml --env-file .env --profile core up -d'
```

Then run the migration once:

```bash
ssh root@165.22.246.45 'cd /root/GaDongHR/deploy && docker compose -p gadonghr exec -T svc-config npm run migrate'
```

- [ ] **Step 5: Verify the stack is up and nothing else broke**

```bash
ssh root@165.22.246.45 'docker compose -p gadonghr ps'
ssh root@165.22.246.45 'docker ps -q | wc -l; docker ps --filter health=unhealthy --format "{{.Names}}"'
```

Expected: all `gadonghr-*` containers `running`/`healthy`; total container count = baseline + the Phase 0 services; **the unhealthy list must be empty** — in particular no pre-existing tenant appears in it.

Spot-check three neighbours are still serving:

```bash
for u in https://form.bevorasg.com https://ims.bevorasg.com https://sign.bevorasg.com; do
  echo -n "$u -> "; curl -sS -o /dev/null -w "%{http_code}\n" -m 15 "$u"
done
```

Expected: 200 or 302 for each. **If any regressed, roll back immediately**: `docker compose -p gadonghr stop` (never `down -v`).

- [ ] **Step 6: Verify through the public URL**

```bash
curl -sS -o /dev/null -w "web    %{http_code}\n" https://hr.bevorasg.com/
curl -sS https://hr.bevorasg.com/api/config/health | tee /dev/stderr | grep -q '"service":"svc-config"'
```

Expected: `web 200`, and a health body like
`{"status":"ok","service":"svc-config","version":"<sha>","dependencies":{"db":"up"}}`.

`"db":"down"` means the role/password wiring from Task 5 Step 6 is wrong — check `docker compose -p gadonghr logs svc-config`.

- [ ] **Step 7: Install the cron jobs**

```bash
ssh root@165.22.246.45 'cp /root/GaDongHR/deploy/scripts/auto-deploy-gadonghr.sh /root/ && \
  cp /root/GaDongHR/deploy/scripts/prune-gadonghr-images.sh /root/ && \
  chmod +x /root/auto-deploy-gadonghr.sh /root/prune-gadonghr-images.sh && \
  crontab -l > /root/crontab.bak-$(date +%Y%m%d%H%M%S) && \
  (crontab -l; \
   echo "# GaDongHR auto-deploy (CI-gated, pulls from GHCR, never builds)"; \
   echo "* * * * * flock -n /tmp/gadonghr-deploy.lock /root/auto-deploy-gadonghr.sh >> /var/log/gadonghr-deploy.log 2>&1"; \
   echo "# GaDongHR SHA-tagged image prune — keep 4. Plain system prune CANNOT see these."; \
   echo "20 20 * * * /root/prune-gadonghr-images.sh >> /var/log/docker-prune.log 2>&1") | crontab -'
```

Verify: `ssh root@165.22.246.45 'crontab -l | grep gadonghr'` — expected: exactly two lines. The crontab was backed up first.

- [ ] **Step 8: Prove push-to-live end to end**

Make a visible, trivial change:

```bash
sed -i '' 's|Phase 0 walking skeleton.|Phase 0 walking skeleton — deploy loop verified.|' web/index.html
git add web/index.html
git commit -m "chore: verify push-to-live deploy loop"
git push
```

Then watch it land:

```bash
gh run watch
ssh root@165.22.246.45 'tail -f /var/log/gadonghr-deploy.log'
```

Expected: within ~2 minutes of CI going green, a `=== Deploy OK: <sha> ===` line.

Confirm from outside:

```bash
curl -sS https://hr.bevorasg.com/ | grep -q "deploy loop verified" && echo "WEB UPDATED"
curl -sS https://hr.bevorasg.com/api/config/health | grep -o '"version":"[^"]*"'
git rev-parse HEAD
```

Expected: `WEB UPDATED`, and the reported `version` equals the local `HEAD` sha.

- [ ] **Step 9: Prove the self-heal**

```bash
ssh root@165.22.246.45 'docker stop gadonghr-web-1'
sleep 90
ssh root@165.22.246.45 'docker ps --filter name=gadonghr-web --format "{{.Names}} {{.Status}}"; tail -5 /var/log/gadonghr-deploy.log'
```

Expected: the container is running again and the log shows a deploy triggered with no new commit — this is the "stack is down, bring it back" branch, the exact gap that left the box down for five hours in July.

- [ ] **Step 10: Final state check and commit**

```bash
ssh root@165.22.246.45 'df -h / | tail -1; free -m | head -2; docker ps -q | wc -l; docker ps --filter health=unhealthy --format "{{.Names}}"'
```

Expected: disk still < 85%, unhealthy list empty, container count = baseline + Phase 0 services.

```bash
git add README.md
git commit -m "docs: record hr.bevorasg.com deployment, port block 21000-21029, and CI/CD loop"
git push
```

Update `README.md` with a Deployment section covering: the host, the reserved port block, the two compose files, the vhost, the two cron jobs, the log paths, and the rule that nothing is ever built on 165.

---

## After Phase 0 — follow-on plans

Phase 0 deliberately covers the platform skeleton and the delivery pipeline only. The remaining work is genuinely independent subsystems and each needs its own plan, written against its own module document:

| Plan | Covers | Source docs | Gate |
|---|---|---|---|
| Phase A — Platform | `@gadong/kernel` outbox + idempotent consumer + authz guard + crypto client; `svc-crypto` with Vault Transit; `svc-authz` RBAC decision API; `svc-audit` hash chain; `svc-i18n`; M1 Onboarding | Security doc §3–§5, ADR-004/005/006, `M1-ONBOARDING.md` | **Capacity decision first** — resize 165 or dedicated host |
| Phase B — Time capture | M2 Scheduler, M4 Attendance (CompreFace + liveness), M3 Timesheet | `M2/M3/M4-*.md`, ADR-007, PRD Q2 benchmark | CompreFace FAR/FRR benchmark passes |
| Phase C — Requests | M5 Leave, M6 Claims | `M5-LEAVE.md`, `M6-CLAIMS.md`, Statutory Spec §3 | Statutory leave defaults pass compliance review |
| Phase D — Payroll | M7 gross-to-net, statutory exports, termination pay | `M7-PAYROLL.md`, Statutory Spec §5–§9 | Two clean parallel runs (UAT §2) |
| Phase E — Hardening | Pen test, PDPA audit, k6 load, restore drill, RBAC matrix generation | Security doc §8, `TEST-STRATEGY.md`, `OPERATIONS-RUNBOOK.md` §3 | Security & compliance sign-off |

Two items from the source docs are **blocking and are not engineering work** — raise them before Phase D: Statutory Spec §12 V2 (the exact gazetted 2026 SSO ceiling) and V1 (the LPA No. 9 maternity pay split). PRD Q2 (face engine selection) blocks Phase B.
