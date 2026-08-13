import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './documents.controller'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving, matching `services/svc-config/src/main.ts`.
 * `createSchema: true` creates the `docs` schema itself if it doesn't exist
 * yet, so a first boot against a fresh database needs nothing pre-
 * provisioned beyond the role/database. Not exercised against a real
 * Postgres in this environment — there is none here (CONSTRAINTS: "no
 * Postgres").
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-docs: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'docs',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-docs: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): drains the
 * `docs` schema's outbox onto `gadong.events` — `document.rendered`, the
 * only event `documents.service.ts` produces (`writeOutbox(tx, 'docs',
 * 'document.rendered', ...)` in `commit()`). `svc-docs` consumes no bus
 * events itself (no `consume` block below — confirmed, there is no
 * consumer/handler class anywhere in `services/svc-docs/src`).
 *
 * NOTE — `document.rendered` is NOT in the roadmap's documented event
 * catalog (`docs/superpowers/plans/00-PROGRAM-ROADMAP.md`'s event catalog
 * table), and nothing anywhere in the codebase consumes it: it is produced
 * but currently orphaned. Wiring the relay to drain it anyway is still
 * correct — an outbox row that is never drained just accumulates forever,
 * which is exactly the defect this task fixes for every service, not only
 * the ones that already have a downstream consumer written.
 */
async function wireEventBus(pool: Pool): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'docs',
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
    console.log(`svc-docs: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-docs: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-docs: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-docs failed to start:', err)
  process.exit(1)
})
