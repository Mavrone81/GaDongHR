import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './notify.controller'
import { NotifyService } from './notify.service'
import type {
  ClaimApprovedForPayrollPayload,
  EmployeeCreatedPayload,
  LeaveApprovedPayload,
  PayslipIssuedPayload,
} from './notify.service'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving (matching `services/svc-config/src/main.ts`).
 * `createSchema: true` creates the `notify` schema itself if it doesn't
 * exist yet, so a first boot against a fresh database needs nothing
 * pre-provisioned beyond the role/database. Not exercised against a real
 * Postgres in this environment — there is none here (Task 11 brief) —
 * Task 13b covers real-Postgres integration.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-notify: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'notify',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-notify: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): dispatches
 * `employee.created`, `leave.approved`, `claim.approved_for_payroll` and
 * `payslip.issued` into the existing, already unit-tested `NotifyService` —
 * this function adapts routing keys to that class's `(tx, eventId, payload)`
 * method shape, it does not reimplement any of its logic.
 *
 * svc-notify never writes to its own outbox (it produces no events of its
 * own — confirmed by grep for `writeOutbox(` under `services/svc-notify/src`),
 * so `publish` is deliberately omitted here — there is nothing for a relay
 * to drain.
 */
async function wireEventBus(pool: Pool, notifyService: NotifyService): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'notify',
    consume: {
      queue: 'q.svc-notify.events',
      routingKeys: ['employee.created', 'leave.approved', 'claim.approved_for_payroll', 'payslip.issued'],
      handlers: {
        'employee.created': (tx, eventId, payload) =>
          notifyService.handleEmployeeCreated(tx, eventId, payload as EmployeeCreatedPayload),
        'leave.approved': (tx, eventId, payload) =>
          notifyService.handleLeaveApproved(tx, eventId, payload as LeaveApprovedPayload),
        'claim.approved_for_payroll': (tx, eventId, payload) =>
          notifyService.handleClaimApprovedForPayroll(tx, eventId, payload as ClaimApprovedForPayrollPayload),
        'payslip.issued': (tx, eventId, payload) =>
          notifyService.handlePayslipIssued(tx, eventId, payload as PayslipIssuedPayload),
      },
      onDeadLetter: (info) => console.error('svc-notify: dead-lettered event', info),
    },
    logger: console,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)

  const pool = app.get<Pool>(DB_POOL)
  const notifyService = app.get(NotifyService)
  const bus = await wireEventBus(pool, notifyService)

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
    console.log(`svc-notify: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-notify: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-notify: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-notify failed to start:', err)
  process.exit(1)
})
