import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './employee.controller'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving, matching `svc-config`'s `main.ts` exactly.
 * `createSchema: true` creates the `onboarding` schema itself if it
 * doesn't exist yet, so a first boot against a fresh database needs
 * nothing pre-provisioned beyond the role/database. `migrationsTable:
 * 'pgmigrations'` is what makes re-running this on every container start
 * idempotent: node-pg-migrate records each applied migration's name in
 * that table and only executes what is not yet recorded, so a second boot
 * against an already-migrated database applies nothing and errors on
 * nothing — it does not re-run `1756000000000_onboarding-schema.js`'s
 * `up()` a second time.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-onboarding: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'onboarding',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-onboarding: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): drains this
 * schema's outbox onto `gadong.events` — `employee.created`,
 * `employee.updated`, `employee.terminated`, `consent.granted`,
 * `consent.withdrawn` (roadmap event catalog, all produced by
 * `employee.service.ts`/`consent.service.ts`). `svc-onboarding` consumes no
 * bus events itself (no `consume` block below) — this is the ONLY producer
 * in the whole system for `employee.*`, which is exactly why nothing
 * draining it was the traced defect: every downstream consumer
 * (`svc-payroll`, `svc-timesheet`, `svc-leave`, `svc-claims`,
 * `svc-scheduler`, `svc-attendance`) depends on THIS service's relay
 * actually running.
 */
async function wireEventBus(pool: Pool): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'onboarding',
    publish: { intervalMs: Number(process.env['OUTBOX_RELAY_INTERVAL_MS'] ?? 5000) },
    logger: console,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)

  const pool = app.get<Pool>(DB_POOL)
  const bus = await wireEventBus(pool)

  await app.listen(3000, '0.0.0.0')

  // See `services/svc-payroll/src/main.ts`'s identical comment for why
  // this is an explicit signal handler rather than Nest's
  // `enableShutdownHooks()`.
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`svc-onboarding: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-onboarding: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-onboarding: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-onboarding failed to start:', err)
  process.exit(1)
})
