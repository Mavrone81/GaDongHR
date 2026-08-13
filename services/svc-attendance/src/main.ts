import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './attendance.controller'
import { ConsentEventHandler } from './consent-event.handler'
import type { ConsentEventPayload } from './consent-event.handler'
import { EmployeeEventHandler } from './employee-event.handler'
import type { EmployeeTerminatedPayload } from './employee-event.handler'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving — the same pattern `services/svc-config/src/main.ts`
 * established (Task 7 brief §6). `createSchema: true` creates the
 * `attendance` schema itself if it doesn't exist yet, so a first boot
 * against a fresh database needs nothing pre-provisioned beyond the
 * role/database. Re-running this on every restart is safe: node-pg-migrate
 * tracks applied migrations in its own `pgmigrations` ledger table and only
 * ever executes a given migration file once — restarting this container
 * (or a kiosk-driven redeploy) never re-applies `1754300000000_attendance-
 * schema.js` a second time. Not exercised against a real Postgres in this
 * environment — there is none here (Task 14 brief CONSTRAINTS) — a later
 * integration task covers real-Postgres behaviour, matching Task 13b for
 * `svc-config`.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-attendance: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'attendance',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-attendance: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): drains the
 * `attendance` schema's outbox (`attendance.punch`,
 * `attendance.liveness_failed`) onto `gadong.events`, and dispatches
 * `consent.granted`/`consent.withdrawn` (published by `svc-onboarding`'s
 * `ConsentService`) into `ConsentEventHandler`, and `employee.terminated`
 * into `EmployeeEventHandler` — the OTHER PDPA §7 template-deletion trigger.
 * This service does NOT consume `employee.created`/`employee.updated`; it
 * has nothing to do with either.
 */
async function wireEventBus(pool: Pool, consentHandler: ConsentEventHandler, employeeHandler: EmployeeEventHandler): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'attendance',
    publish: { intervalMs: Number(process.env['OUTBOX_RELAY_INTERVAL_MS'] ?? 5000) },
    consume: {
      queue: 'q.svc-attendance.events',
      routingKeys: ['consent.granted', 'consent.withdrawn', 'employee.terminated'],
      handlers: {
        'consent.granted': (tx, eventId, payload) => consentHandler.handleGranted(tx, eventId, payload as ConsentEventPayload),
        'consent.withdrawn': (tx, eventId, payload) => consentHandler.handleWithdrawn(tx, eventId, payload as ConsentEventPayload),
        'employee.terminated': (tx, eventId, payload) => employeeHandler.handleTerminated(tx, eventId, payload as EmployeeTerminatedPayload),
      },
      onDeadLetter: (info) => console.error('svc-attendance: dead-lettered event', info),
    },
    logger: console,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)

  const pool = app.get<Pool>(DB_POOL)
  const consentHandler = app.get(ConsentEventHandler)
  const employeeHandler = app.get(EmployeeEventHandler)
  const bus = await wireEventBus(pool, consentHandler, employeeHandler)

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
    console.log(`svc-attendance: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-attendance: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-attendance: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-attendance failed to start:', err)
  process.exit(1)
})
