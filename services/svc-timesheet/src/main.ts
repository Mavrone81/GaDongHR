import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './timesheet.controller'
import { EventsConsumer } from './events.consumer'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving — identical shape to `services/svc-config`'s
 * `runMigrations` (Task 14 brief: "src/main.ts runs migrations then listens
 * on 3000, matching svc-config"). `createSchema: true` creates the
 * `timesheet` schema itself if it doesn't exist yet, so a first boot
 * against a fresh database needs nothing pre-provisioned beyond the
 * role/database.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-timesheet: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'timesheet',
    createSchema: true,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-timesheet: ${name} is required`)
  return value
}

/**
 * Wires this service onto the message bus (event-bus task): drains this
 * schema's outbox (`timesheet.locked`, `timesheet.unlocked`,
 * `timesheet.corrected`) onto `gadong.events`, and dispatches
 * `attendance.punch`, `roster.entry.published`, `leave.approved`,
 * `leave.cancelled`, `ot.approved` and `employee.created`/`updated`/
 * `terminated` into the existing, already unit-tested `EventsConsumer` —
 * this function adapts routing keys to that class's method shapes, it does
 * not reimplement any of its logic.
 *
 * `attendance.punch` is the one exception to the "dispatch by routing key,
 * dedupe on the AMQP messageId" pattern every other handler below follows:
 * `EventsConsumer.handleAttendancePunch` takes no `eventId` argument at
 * all — it dedupes on the event's OWN `idemKey` field (see that method's
 * doc: kiosk-generated, so it survives offline queueing before the kiosk
 * even knows whether the broker is reachable). The AMQP `messageId` this
 * loop reads is still present on the message (every outbox row gets one),
 * it is simply unused by this one handler.
 */
async function wireEventBus(pool: Pool, consumer: EventsConsumer): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'timesheet',
    publish: { intervalMs: Number(process.env['OUTBOX_RELAY_INTERVAL_MS'] ?? 5000) },
    consume: {
      queue: 'q.svc-timesheet.events',
      routingKeys: [
        'attendance.punch',
        'roster.entry.published',
        'leave.approved',
        'leave.cancelled',
        'ot.approved',
        'employee.created',
        'employee.updated',
        'employee.terminated',
      ],
      handlers: {
        'attendance.punch': (tx, _eventId, payload) => consumer.handleAttendancePunch(tx, payload),
        'roster.entry.published': (tx, eventId, payload) => consumer.handleRosterEntryPublished(tx, eventId, payload),
        'leave.approved': (tx, eventId, payload) => consumer.handleLeaveApproved(tx, eventId, payload),
        'leave.cancelled': (tx, eventId, payload) => consumer.handleLeaveCancelled(tx, eventId, payload),
        'ot.approved': (tx, eventId, payload) => consumer.handleOtApproved(tx, eventId, payload),
        'employee.created': (tx, eventId, payload) => consumer.handleEmployeeUpsert(tx, eventId, payload),
        'employee.updated': (tx, eventId, payload) => consumer.handleEmployeeUpsert(tx, eventId, payload),
        'employee.terminated': (tx, eventId, payload) => consumer.handleEmployeeUpsert(tx, eventId, payload),
      },
      onDeadLetter: (info) => console.error('svc-timesheet: dead-lettered event', info),
    },
    logger: console,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)

  const pool = app.get<Pool>(DB_POOL)
  const consumer = app.get(EventsConsumer)
  const bus = await wireEventBus(pool, consumer)

  await app.listen(3000, '0.0.0.0')

  // See `svc-payroll/src/main.ts`'s identical comment for why this is an
  // explicit signal handler rather than Nest's `enableShutdownHooks()`.
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`svc-timesheet: received ${signal}, shutting down gracefully`)
    bus
      .stop()
      .catch((err: unknown) => console.error('svc-timesheet: error stopping event bus', err))
      .finally(() => {
        app
          .close()
          .catch((err: unknown) => console.error('svc-timesheet: error closing app', err))
          .finally(() => process.exit(0))
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootstrap().catch((err: unknown) => {
  console.error('svc-timesheet failed to start:', err)
  process.exit(1)
})
