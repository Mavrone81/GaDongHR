import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './payroll.controller'
import { EventConsumersService } from './event-consumers.service'
import type {
  ClaimApprovedForPayrollEvent,
  EmployeeEvent,
  LeaveBalancePayoutEvent,
  TimesheetLockedEvent,
} from './event-consumers.service'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving — the same pattern `services/svc-config/src/main.ts`
 * established (Task 7 brief §6), followed exactly by
 * `services/svc-attendance/src/main.ts` (Task 14). `createSchema: true`
 * creates the `payroll` schema itself if it doesn't exist yet, so a first
 * boot against a fresh database needs nothing pre-provisioned beyond the
 * role/database. Re-running this on every restart is safe: node-pg-migrate
 * tracks applied migrations in its own `pgmigrations` ledger table and only
 * ever executes a given migration file once — restarting this container
 * never re-applies `1754700000000_payroll-schema.js` a second time.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-payroll: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'payroll',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-payroll: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): drains this
 * schema's outbox (`payroll.committed`, `payslip.issued`) onto
 * `gadong.events`, and dispatches `timesheet.locked`/`timesheet.unlocked`,
 * `leave.balance_payout`, `claim.approved_for_payroll` and
 * `employee.created`/`updated`/`terminated` into the existing, already
 * unit-tested `EventConsumersService` — this function adapts routing keys
 * to that class's `(tx, event)` method shape, it does not reimplement any
 * of its logic.
 *
 * This is the fix for the traced production defect: `RunsService.calculateOne`
 * reads `payroll_employee_ref`, which before this change was fed by a
 * relay that never ran and a consumer that was never subscribed — so
 * every employee looked unknown to payroll (`provinceCode: ''`,
 * `minimumWageNotOnFile`). Once `employee.created` actually reaches
 * `EventConsumersService.handleEmployee`, that ref row exists before
 * payroll ever runs a calculation for the employee.
 */
async function wireEventBus(pool: Pool, consumers: EventConsumersService): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'payroll',
    publish: { intervalMs: Number(process.env['OUTBOX_RELAY_INTERVAL_MS'] ?? 5000) },
    consume: {
      queue: 'q.svc-payroll.events',
      routingKeys: [
        'timesheet.locked',
        'timesheet.unlocked',
        'leave.balance_payout',
        'claim.approved_for_payroll',
        'employee.created',
        'employee.updated',
        'employee.terminated',
      ],
      handlers: {
        'timesheet.locked': (tx, eventId, payload) =>
          consumers.handleTimesheetLock(tx, { topic: 'timesheet.locked', eventId, payload: payload as TimesheetLockedEvent['payload'] }),
        'timesheet.unlocked': (tx, eventId, payload) =>
          consumers.handleTimesheetLock(tx, { topic: 'timesheet.unlocked', eventId, payload: payload as TimesheetLockedEvent['payload'] }),
        'leave.balance_payout': (tx, eventId, payload) =>
          consumers.handleLeavePayout(tx, { topic: 'leave.balance_payout', eventId, payload: payload as LeaveBalancePayoutEvent['payload'] }),
        'claim.approved_for_payroll': (tx, eventId, payload) =>
          consumers.handleClaimApproved(tx, { topic: 'claim.approved_for_payroll', eventId, payload: payload as ClaimApprovedForPayrollEvent['payload'] }),
        'employee.created': (tx, eventId, payload) =>
          consumers.handleEmployee(tx, { topic: 'employee.created', eventId, payload: payload as EmployeeEvent['payload'] }),
        'employee.updated': (tx, eventId, payload) =>
          consumers.handleEmployee(tx, { topic: 'employee.updated', eventId, payload: payload as EmployeeEvent['payload'] }),
        'employee.terminated': (tx, eventId, payload) =>
          consumers.handleEmployee(tx, { topic: 'employee.terminated', eventId, payload: payload as EmployeeEvent['payload'] }),
      },
      onDeadLetter: (info) => console.error('svc-payroll: dead-lettered event', info),
    },
    logger: console,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)

  const pool = app.get<Pool>(DB_POOL)
  const consumers = app.get(EventConsumersService)
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
    console.log(`svc-payroll: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-payroll: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-payroll: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-payroll failed to start:', err)
  process.exit(1)
})
