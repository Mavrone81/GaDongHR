import { join } from 'node:path'
import { runner } from 'node-pg-migrate'

/**
 * retention-job — nightly PDPA retention & crypto-erasure worker.
 *
 * THIS FILE DELIBERATELY OPENS NO HTTP LISTENER AND EXPOSES NO `/health`
 * ROUTE. Every other service in `services/*` boots NestJS and listens on
 * port 3000 because every other service has callers. This one doesn't:
 * `retention-job` is the one component in this repo with no `svc-` prefix,
 * precisely because it serves nothing (Task 14 brief). It is a scheduled
 * worker that runs migrations, does its (Phase 5) work, and exits — there
 * is no route for `deploy/docker-compose.yml`'s health-check machinery to
 * poll, and no client anywhere in this codebase holds a URL for it. Do not
 * "fix" this by adding `NestFactory.create(...).listen(3000)` to match the
 * other services — that would be the mistake, not the omission. See
 * `src/main.test.ts` for the assertion that enforces this.
 *
 * `runMigrations` mirrors `services/svc-config/src/main.ts` exactly:
 * `createSchema: true` means a first boot against a fresh database needs
 * nothing pre-provisioned beyond the role/database itself. Not exercised
 * against a real Postgres in this environment (Task 14 brief CONSTRAINTS —
 * no Postgres here); a later task covers real-Postgres integration,
 * matching Tasks 7/8/9's precedent.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('retention-job: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'retention',
    createSchema: true,
  })
}

/**
 * The nightly scan → DPO review queue → crypto-erasure → physical-delete
 * pipeline (DATABASE-DESIGN §4) is explicit Phase 5 scope — this task
 * scaffolds the schema and the worker shell only (Task 14 brief: "Do NOT
 * implement the scan, the DPO queue, crypto-erasure or the conflict
 * resolution"). This placeholder exists so `bootstrap` has something
 * concrete to call and log, instead of silently doing nothing on every run
 * until Phase 5 lands — a silent no-op nightly job is exactly the kind of
 * thing that looks fine in every log until an auditor asks when a record
 * was actually erased.
 */
function runRetentionCycle(): void {
  console.log('retention-job: migrations applied; scan/DPO-queue/crypto-erasure pipeline is Phase 5 scope — no-op this run')
}

/**
 * Runs once per container invocation: migrate, then run the (still Phase-5)
 * cycle, then return — there is no `setInterval`/resident scheduler here.
 * The "nightly" cadence (DATABASE-DESIGN §4) is expected to come from an
 * external scheduler invoking this container on a cron, the same pattern
 * this repo already uses for its image-prune cron (roadmap, "Standing
 * constraints"), rather than from a long-lived process sleeping in between
 * runs. That keeps the container's lifecycle boring and inspectable: it
 * starts, it does exactly one cycle's worth of work, it exits with a status
 * code an external scheduler can act on. If Phase 5 needs a resident
 * scheduler instead (e.g. to run sub-daily, or because the deployment model
 * changes), that's a deliberate, reviewable change to this function — not
 * an accidental side effect of this scaffold.
 */
async function bootstrap(): Promise<void> {
  await runMigrations()
  runRetentionCycle()
}

bootstrap()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('retention-job: run failed:', err)
    process.exit(1)
  })
