import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './claims.controller'
import { EmployeeEventsService } from './employee-events.service'
import type { EmployeeEvent } from './employee-events.service'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving — the same pattern `services/svc-config/src/main.ts`
 * established (Task 7 brief §6) and `services/svc-leave/src/main.ts`
 * carried forward (Task 14). `createSchema: true` creates the `claims`
 * schema itself if it doesn't exist yet, so a first boot against a fresh
 * database needs nothing pre-provisioned beyond the role/database.
 * Re-running this on every restart is safe: node-pg-migrate tracks
 * applied migrations in its own `pgmigrations` ledger table and only ever
 * executes a given migration file once. Not exercised against a real
 * Postgres in this environment — there is none here (Task 14 brief
 * CONSTRAINTS) — a later integration task covers real-Postgres behaviour,
 * matching Task 13b for `svc-config`.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-claims: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'claims',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-claims: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): drains the
 * `claims` schema's outbox (`claim.approved_for_payroll`, `claim.paid_offcycle`)
 * onto `gadong.events`, and dispatches `employee.created`/`updated`/
 * `terminated` into the existing, already unit-tested
 * `EmployeeEventsService` — this function adapts routing keys to that
 * class's single `handle(tx, event)` method shape, it does not reimplement
 * any of its logic.
 */
async function wireEventBus(pool: Pool, consumers: EmployeeEventsService): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'claims',
    publish: { intervalMs: Number(process.env['OUTBOX_RELAY_INTERVAL_MS'] ?? 5000) },
    consume: {
      queue: 'q.svc-claims.events',
      routingKeys: ['employee.created', 'employee.updated', 'employee.terminated'],
      handlers: {
        'employee.created': (tx, eventId, payload) =>
          consumers.handle(tx, { topic: 'employee.created', eventId, payload: payload as EmployeeEvent['payload'] }),
        'employee.updated': (tx, eventId, payload) =>
          consumers.handle(tx, { topic: 'employee.updated', eventId, payload: payload as EmployeeEvent['payload'] }),
        'employee.terminated': (tx, eventId, payload) =>
          consumers.handle(tx, { topic: 'employee.terminated', eventId, payload: payload as EmployeeEvent['payload'] }),
      },
      onDeadLetter: (info) => console.error('svc-claims: dead-lettered event', info),
    },
    logger: console,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)

  const pool = app.get<Pool>(DB_POOL)
  const consumers = app.get(EmployeeEventsService)
  const bus = await wireEventBus(pool, consumers)

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
    console.log(`svc-claims: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-claims: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-claims: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-claims failed to start:', err)
  process.exit(1)
})
