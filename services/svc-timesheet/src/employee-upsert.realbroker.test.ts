/**
 * Real-broker, real-Postgres proof that `svc-timesheet`'s `EventsConsumer`
 * — the other consumer explicitly named in the event-bus task brief
 * alongside `svc-payroll`'s — is genuinely wired to real deliveries, not
 * just unit-tested against a fake. Complements
 * `packages/kernel/src/bus/transport.realbroker.test.ts` (generic
 * transport proof) and
 * `services/svc-payroll/src/hire-to-payroll.realbroker.test.ts` (the
 * flagship hire→payroll defect closure) rather than repeating them: this
 * file exercises `EventsConsumer.handleEmployeeUpsert` specifically, the
 * method `main.ts` binds `employee.created`/`employee.updated`/
 * `employee.terminated` to.
 *
 * Requires `deploy/docker-compose.eventbus-test.yml`'s `postgres` +
 * `rabbitmq` up and the `timesheet` schema migrated — see
 * `.superpowers/sdd/02-modules/event-bus.md`. Run with `pnpm
 * test:realbroker`, never as part of plain `pnpm test`.
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { AmqpPublisher, ConsumerLoop } from '@gadong/kernel'
import { ConsolidationService } from './consolidation.service'
import { EmployeeRefRepository } from './employee-ref.repository'
import { DayRecordRepository } from './day-record.repository'
import { ExceptionRepository } from './exception.repository'
import { RosterRefRepository } from './roster-ref.repository'
import { LeaveRefRepository } from './leave-ref.repository'
import { OtApprovalRefRepository } from './ot-approval-ref.repository'
import { CorrectionAuditRepository } from './correction-audit.repository'
import { ConfigClient } from './config-client'
import type { ConfigTransport } from './config-client'
import { EventsConsumer } from './events.consumer'

const DATABASE_URL = process.env['EVENTBUS_TEST_DATABASE_URL_TIMESHEET'] ?? 'postgresql://timesheet:test_pw@localhost:25432/gadonghr_eventbus_test'
const RABBITMQ_URL = process.env['EVENTBUS_TEST_RABBITMQ_URL'] ?? 'amqp://gadong_test:gadong_test_pw@localhost:25672'

/** `ConsolidationService` is a required constructor dependency of `EventsConsumer` but `handleEmployeeUpsert` never calls into it — see that method's body. Throwing on use turns an accidental dependency into a loud test failure instead of a silent pass. */
const unusedConfigTransport: ConfigTransport = {
  get: () => Promise.reject(new Error('employee-upsert real-broker test: ConfigClient must not be called by handleEmployeeUpsert')),
}

let pool: Pool

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL })
})

afterAll(async () => {
  await pool.end()
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return check()
}

describe('svc-timesheet EventsConsumer.handleEmployeeUpsert against a real broker', () => {
  it('a real employee.created delivery creates a real timesheet_employee_ref row', async () => {
    const employeeRefs = new EmployeeRefRepository(pool)
    const consolidation = new ConsolidationService(
      new DayRecordRepository(pool),
      new ExceptionRepository(pool),
      new RosterRefRepository(pool),
      new LeaveRefRepository(pool),
      new OtApprovalRefRepository(pool),
      employeeRefs,
      new CorrectionAuditRepository(pool),
      new ConfigClient(unusedConfigTransport),
    )
    const consumer = new EventsConsumer(consolidation, employeeRefs)

    const loop = new ConsumerLoop({
      url: RABBITMQ_URL,
      pool,
      queue: `q.timesheet-employee-upsert-test.${randomUUID()}`,
      routingKeys: ['employee.created'],
      handlers: {
        'employee.created': (tx, eventId, payload) => consumer.handleEmployeeUpsert(tx, eventId, payload),
      },
    })
    await loop.start()

    try {
      const employeeId = randomUUID()
      const publisher = new AmqpPublisher({ url: RABBITMQ_URL })
      try {
        await publisher.publish(
          'employee.created',
          {
            id: employeeId,
            empCode: `E-${employeeId.slice(0, 8)}`,
            orgUnitId: randomUUID(),
            employmentType: 'monthly',
            status: 'active',
          },
          randomUUID(),
        )
      } finally {
        await publisher.close()
      }

      await expect(waitFor(async () => (await employeeRefs.findById(employeeId)) !== null)).resolves.toBe(true)
      const ref = await employeeRefs.findById(employeeId)
      expect(ref?.employeeId).toBe(employeeId)
      expect(ref?.employmentType).toBe('monthly')
    } finally {
      await loop.stop()
    }
  })
})
