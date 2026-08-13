import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './rules.controller'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving (Task 7 brief §6). `createSchema: true` creates the
 * `config` schema itself if it doesn't exist yet, so a first boot against a
 * fresh database needs nothing pre-provisioned beyond the role/database.
 * Not exercised against a real Postgres in this environment — there is
 * none here (Task 7 brief) — Task 13b covers real-Postgres integration.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-config: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'config',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-config: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): drains this
 * schema's outbox onto `gadong.events` — `rules.updated`, the only event
 * `svc-config` produces (`rules.service.ts`'s `approve()`, in the same
 * transaction as the status change, via kernel's `writeOutbox`).
 * `svc-config` consumes no bus events itself — no `consume` block below —
 * matching `svc-onboarding`'s producer-only shape exactly.
 *
 * AS OF TODAY, NOTHING IN THE CODEBASE CONSUMES `rules.updated` — it is
 * produced but has no subscriber anywhere in the system. That is honestly
 * documented here rather than implied otherwise: every other service still
 * resolves statutory figures by calling `svc-config`'s HTTP API directly
 * (e.g. `svc-payroll`'s `CONFIG_HEALTH`/`configHealth` reachability check),
 * not by reacting to this event. Draining the outbox is still correct and
 * required regardless — an undrained outbox is a stuck queue whether or not
 * anything is listening yet, and a future consumer only needs to start
 * consuming, not wait for a backlog to be relayed.
 */
async function wireEventBus(pool: Pool): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'config',
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
    console.log(`svc-config: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-config: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-config: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-config failed to start:', err)
  process.exit(1)
})
