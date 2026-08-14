import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import type { Pool } from 'pg'
import { startEventBus } from '@gadong/kernel'
import type { EventBus } from '@gadong/kernel'
import { AppModule } from './app.module'
import { DB_POOL } from './documents.controller'
import { EventsConsumer } from './events.consumer'

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
 * 'document.rendered', ...)` in `commit()`).
 *
 * NOTE — `document.rendered` is NOT in the roadmap's documented event
 * catalog (`docs/superpowers/plans/00-PROGRAM-ROADMAP.md`'s event catalog
 * table), and nothing anywhere in the codebase consumes it: it is produced
 * but currently orphaned. Wiring the relay to drain it anyway is still
 * correct — an outbox row that is never drained just accumulates forever,
 * which is exactly the defect this task fixes for every service, not only
 * the ones that already have a downstream consumer written.
 *
 * **`consume` block added by the row-scoping fix** (roadmap "🔴 Open
 * security gap"): `GET /documents/:id`'s ownership check
 * (`documents.service.ts#getDocument`) needs to know a document's owning
 * employee's org unit, and — for `kind: 'payslip'` documents specifically
 * — which employee a payslip even belongs to (`entity_id` there is the
 * payslip's own id, not the employee's; see `payslip-ref.repository.ts`'s
 * doc). `employee.created`/`employee.updated` feed `docs.employee_ref`;
 * `payslip.issued` feeds `docs.payslip_ref`. Same dispatch-by-routing-key
 * shape as `services/svc-timesheet/src/main.ts`.
 *
 * Deliberately NOT subscribed to `employee.terminated`: that event's real
 * payload (`services/svc-onboarding/src/employee.service.ts`'s `transition`
 * — `{id, terminationDate, reasonCategory}`, matching the roadmap's own
 * event-catalog row) carries no `orgUnitId`, so routing it through the same
 * `handleEmployeeUpsert`/`parseEmployeeUpsert` path `svc-timesheet`'s
 * `main.ts` does would throw "missing orgUnitId" on every real termination
 * — and there is nothing for `docs.employee_ref` to update anyway: a
 * termination does not change which org unit an employee's past documents
 * belong to for row-scoping purposes.
 */
async function wireEventBus(pool: Pool, consumer: EventsConsumer): Promise<EventBus> {
  const amqpUrl = requiredEnv('RABBITMQ_URL')
  return startEventBus({
    amqpUrl,
    pool,
    schema: 'docs',
    publish: { intervalMs: Number(process.env['OUTBOX_RELAY_INTERVAL_MS'] ?? 5000) },
    consume: {
      queue: 'q.svc-docs.events',
      routingKeys: ['employee.created', 'employee.updated', 'payslip.issued'],
      handlers: {
        'employee.created': (tx, eventId, payload) => consumer.handleEmployeeUpsert(tx, eventId, payload),
        'employee.updated': (tx, eventId, payload) => consumer.handleEmployeeUpsert(tx, eventId, payload),
        'payslip.issued': (tx, eventId, payload) => consumer.handlePayslipIssued(tx, eventId, payload),
      },
      onDeadLetter: (info) => console.error('svc-docs: dead-lettered event', info),
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
