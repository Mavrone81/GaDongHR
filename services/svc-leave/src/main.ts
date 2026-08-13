import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './leave.controller'
import { EmployeeRefConsumer } from './employee-ref.consumer'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving — the same pattern `services/svc-config/src/main.ts`
 * established (Task 7 brief §6) and `services/svc-attendance/src/main.ts`
 * carried forward. `createSchema: true` creates the `leave` schema itself
 * if it doesn't exist yet, so a first boot against a fresh database needs
 * nothing pre-provisioned beyond the role/database. Re-running this on
 * every restart is safe: node-pg-migrate tracks applied migrations in its
 * own `pgmigrations` ledger table and only ever executes a given migration
 * file once. Not exercised against a real Postgres in this environment —
 * there is none here (Task 14 brief CONSTRAINTS) — a later integration
 * task covers real-Postgres behaviour, matching Task 13b for `svc-config`.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-leave: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'leave',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-leave: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): drains the
 * `leave` schema's outbox (`leave.approved`, `leave.cancelled`,
 * `leave.balance_payout`) onto `gadong.events`, and dispatches
 * `employee.created`/`employee.updated`/`employee.terminated` into the
 * existing, already unit-tested `EmployeeRefConsumer` — this function
 * adapts routing keys to that class's `(tx, eventId, payload)` method
 * shapes, it does not reimplement any of its logic.
 */
async function wireEventBus(pool: Pool, consumer: EmployeeRefConsumer): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'leave',
    publish: { intervalMs: Number(process.env['OUTBOX_RELAY_INTERVAL_MS'] ?? 5000) },
    consume: {
      queue: 'q.svc-leave.events',
      routingKeys: ['employee.created', 'employee.updated', 'employee.terminated'],
      handlers: {
        'employee.created': (tx, eventId, payload) => consumer.handleCreatedOrUpdated(tx, eventId, payload),
        'employee.updated': (tx, eventId, payload) => consumer.handleCreatedOrUpdated(tx, eventId, payload),
        'employee.terminated': (tx, eventId, payload) => consumer.handleTerminated(tx, eventId, payload),
      },
      onDeadLetter: (info) => console.error('svc-leave: dead-lettered event', info),
    },
    logger: console,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)

  const pool = app.get<Pool>(DB_POOL)
  const consumer = app.get(EmployeeRefConsumer)
  const bus = await wireEventBus(pool, consumer)

  await app.listen(3000, '0.0.0.0')

  // See `svc-payroll/src/main.ts`'s identical comment for why this is an
  // explicit signal handler rather than Nest's `enableShutdownHooks()`.
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`svc-leave: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-leave: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-leave: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-leave failed to start:', err)
  process.exit(1)
})
