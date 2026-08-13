import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './health.controller'
import { EventsService } from './events.service'
import type {
  EmployeeCreatedOrUpdatedPayload,
  EmployeeTerminatedPayload,
  LeaveApprovedPayload,
  LeaveCancelledPayload,
} from './events.service'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving, matching `services/svc-config/src/main.ts`.
 * `createSchema: true` creates the `scheduler` schema itself if it doesn't
 * exist yet, so a first boot against a fresh database needs nothing
 * pre-provisioned beyond the role/database. `migrationsTable: 'pgmigrations'`
 * is node-pg-migrate's own applied-migrations ledger — it is what makes
 * re-running this function on every restart idempotent: a migration file
 * already recorded there is never re-executed, so `1754400000000_scheduler-
 * schema.js`'s `up()` runs at most once per database regardless of how many
 * times this process (re)starts.
 *
 * Not exercised against a real Postgres in this environment — there is none
 * here (Task 14 brief CONSTRAINTS) — a later integration task covers
 * real-Postgres verification, matching Task 7's deferral.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-scheduler: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'scheduler',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-scheduler: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): drains this
 * schema's outbox (`roster.published`, `roster.entry.published`,
 * `ot.approved`) onto `gadong.events`, and dispatches
 * `employee.created`/`employee.updated`/`employee.terminated` and
 * `leave.approved`/`leave.cancelled` into the existing, already
 * unit-tested `EventsService` — this function adapts routing keys to that
 * class's `(tx, eventId, payload)` method shape, it does not reimplement
 * any of its logic.
 */
async function wireEventBus(pool: Pool, events: EventsService): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'scheduler',
    publish: { intervalMs: Number(process.env['OUTBOX_RELAY_INTERVAL_MS'] ?? 5000) },
    consume: {
      queue: 'q.svc-scheduler.events',
      routingKeys: ['employee.created', 'employee.updated', 'employee.terminated', 'leave.approved', 'leave.cancelled'],
      handlers: {
        'employee.created': (tx, eventId, payload) =>
          events.handleEmployeeCreatedOrUpdated(tx, eventId, payload as EmployeeCreatedOrUpdatedPayload),
        'employee.updated': (tx, eventId, payload) =>
          events.handleEmployeeCreatedOrUpdated(tx, eventId, payload as EmployeeCreatedOrUpdatedPayload),
        'employee.terminated': (tx, eventId, payload) => events.handleEmployeeTerminated(tx, eventId, payload as EmployeeTerminatedPayload),
        'leave.approved': (tx, eventId, payload) => events.handleLeaveApproved(tx, eventId, payload as LeaveApprovedPayload),
        'leave.cancelled': (tx, eventId, payload) => events.handleLeaveCancelled(tx, eventId, payload as LeaveCancelledPayload),
      },
      onDeadLetter: (info) => console.error('svc-scheduler: dead-lettered event', info),
    },
    logger: console,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)

  const pool = app.get<Pool>(DB_POOL)
  const events = app.get(EventsService)
  const bus = await wireEventBus(pool, events)

  await app.listen(3000, '0.0.0.0')

  // Explicit signal handling rather than Nest's `enableShutdownHooks()` +
  // lifecycle interfaces: the shutdown ORDER here — stop the bus (so no
  // message starts a new DB transaction), THEN close the HTTP server —
  // matters, and is simpler to read as one linear function than split
  // across multiple providers' `onModuleDestroy`. Matches
  // `services/svc-payroll/src/main.ts`'s identical shutdown wiring.
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`svc-scheduler: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-scheduler: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-scheduler: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-scheduler failed to start:', err)
  process.exit(1)
})
