import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './entries.controller'
import { AuditConsumer } from './consumer'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the app
 * starts serving, matching `services/svc-config`'s `main.ts`. `createSchema:
 * true` creates the `audit` schema itself if it doesn't exist yet.
 *
 * This connection must be a privileged/owner role, never the `audit` role
 * the migration itself creates and locks down to SELECT/INSERT only — the
 * migration issues `CREATE SCHEMA`/`CREATE TABLE`/`GRANT`, none of which the
 * `audit` role could do to itself. Provisioning which role `DATABASE_URL`
 * authenticates as for the migration step vs. the app's runtime queries is
 * an infra/deploy-bootstrap concern outside this service's `src`/
 * `migrations` (see task-9-report.md).
 *
 * Not exercised against a real Postgres in this environment — there is none
 * here (Task 9 brief CONSTRAINTS).
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-audit: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'audit',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-audit: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task). `svc-audit` is
 * the ONLY wildcard consumer in the system: every other service's
 * `AuditEmitter.emit` (`packages/kernel/src/audit/emitter.ts`) publishes
 * into ITS OWN outbox under `audit.<action>` — an arbitrary, producer-chosen
 * action string appended after `audit.`, e.g. `audit.employee.create` or
 * `audit.payroll.run.commit` — so this queue binds the wildcard routing key
 * `audit.#` and dispatches through `fallbackHandler`, using the routing key
 * actually delivered (`topic`) rather than an exact `handlers` lookup table.
 *
 * No `publish` key: `svc-audit` never writes to its own outbox (confirmed —
 * no `writeOutbox(` call anywhere in this service's `src`; its own
 * `testing/fake-db.ts` has no outbox-insert branch at all). It is a pure
 * sink of every other service's audit trail, never a producer of one.
 */
function wireEventBus(pool: Pool, auditConsumer: AuditConsumer): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'audit',
    consume: {
      queue: 'q.svc-audit.events',
      routingKeys: ['audit.#'],
      fallbackHandler: (tx, eventId, topic, payload) => auditConsumer.consume(tx, { eventId, topic, payload }),
      onDeadLetter: (info) => console.error('svc-audit: dead-lettered event', info),
    },
    logger: console,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)

  const pool = app.get<Pool>(DB_POOL)
  const auditConsumer = app.get(AuditConsumer)
  const bus = await wireEventBus(pool, auditConsumer)

  await app.listen(3000, '0.0.0.0')

  // Explicit signal handling rather than Nest's `enableShutdownHooks()` +
  // lifecycle interfaces: the shutdown ORDER here — stop the bus (so no
  // message starts a new DB transaction), THEN close the HTTP server —
  // matters, and is simpler to read as one linear function than split
  // across multiple providers' `onModuleDestroy`. Matches this file's own
  // existing house style of an explicit async `bootstrap()` doing ordered
  // setup rather than framework-lifecycle magic (see `runMigrations`
  // above, which already runs before `NestFactory.create` for the same
  // reason).
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`svc-audit: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-audit: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-audit: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-audit failed to start:', err)
  process.exit(1)
})
