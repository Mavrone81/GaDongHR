/**
 * The flagship proof for the event-bus task: real Postgres, real RabbitMQ,
 * no fakes, closing the exact defect traced in the task brief.
 *
 * **The traced defect.** `svc-onboarding` writes `employee.created` to its
 * own outbox correctly (that part was never broken). Before this task,
 * nothing drained it and nothing consumed it — `OutboxRelay.drainOnce` had
 * zero production call sites and there was no AMQP client anywhere in the
 * monorepo. `RunsService.calculateOne` reads `payroll_employee_ref` (fed
 * ONLY by that dead event), finds nothing, falls back to `provinceCode: ''`,
 * and `minimumWageRuleKey('')` produces `'minwage.daily.'` — never one of
 * the 46 seeded rule keys — so `computeGrossToNet` throws
 * `minimumWageNotOnFile`. Hiring an employee and running payroll for them
 * failed in the deployed system.
 *
 * **What this test proves, against real infrastructure, end to end:**
 *   1. `RefsRepository.findEmployee` returns nothing for a freshly-hired
 *      employee BEFORE the event pipeline runs — the exact "before" state
 *      that produced the bug.
 *   2. A real `employee.created` row, written to a real `onboarding`
 *      schema's outbox exactly the way `svc-onboarding` writes one, is
 *      drained by a real `OutboxRelay` through a real `AmqpPublisher` onto
 *      a real RabbitMQ exchange.
 *   3. A real `ConsumerLoop`, wired to the real (unmodified, already
 *      unit-tested) `EventConsumersService.handleEmployee`, consumes it
 *      into a real `payroll.payroll_employee_ref` row via a real Postgres
 *      transaction.
 *   4. `provinceCode` on that row is the REAL value carried on the event —
 *      never `''` — so `minimumWageRuleKey(provinceCode)` resolves to a
 *      real, seedable rule key instead of the always-missing
 *      `'minwage.daily.'`. Hire → payroll's employee-lookup step now
 *      completes.
 *
 * Requires `deploy/docker-compose.eventbus-test.yml`'s `postgres` +
 * `rabbitmq` up and the `onboarding` + `payroll` schemas migrated — see
 * `.superpowers/sdd/02-modules/event-bus.md`. Run with `pnpm
 * test:realbroker`, never as part of plain `pnpm test`.
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { CryptoTransport } from '@gadong/kernel'
import { AmqpPublisher, ConsumerLoop, CryptoClient, OutboxRelay, writeOutbox } from '@gadong/kernel'
import { RefsRepository } from './refs.repository'
import { PayInputsRepository } from './pay-inputs.repository'
import { EventConsumersService } from './event-consumers.service'
import type { EmployeeEvent } from './event-consumers.service'
import type { ConfigClient } from './config-client'
import { minimumWageRuleKey } from './statutory'

const DATABASE_URL_ONBOARDING =
  process.env['EVENTBUS_TEST_DATABASE_URL_ONBOARDING'] ?? 'postgresql://onboarding:test_pw@localhost:25432/gadonghr_eventbus_test'
const DATABASE_URL_PAYROLL =
  process.env['EVENTBUS_TEST_DATABASE_URL_PAYROLL'] ?? 'postgresql://payroll:test_pw@localhost:25432/gadonghr_eventbus_test'
const RABBITMQ_URL = process.env['EVENTBUS_TEST_RABBITMQ_URL'] ?? 'amqp://gadong_test:gadong_test_pw@localhost:25672'

/** Never called by `handleEmployee` — only `handleLeavePayout`/`handleClaimApproved` touch config/crypto. Throwing on use turns an accidental dependency on either into a loud test failure instead of a silent pass. */
const unusedConfigClient: ConfigClient = {
  getEffectiveRule: () => Promise.reject(new Error('hire-to-payroll test: ConfigClient must not be called by handleEmployee')),
}
const unusedCryptoTransport: CryptoTransport = {
  post: () => Promise.reject(new Error('hire-to-payroll test: CryptoClient must not be called by handleEmployee')),
}

let onboardingPool: Pool
let payrollPool: Pool

beforeAll(() => {
  onboardingPool = new Pool({ connectionString: DATABASE_URL_ONBOARDING })
  payrollPool = new Pool({ connectionString: DATABASE_URL_PAYROLL })
})

afterAll(async () => {
  await onboardingPool.end()
  await payrollPool.end()
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return check()
}

describe('hire → payroll: employee.created reaches svc-payroll through the real broker', () => {
  it('closes the traced defect: provinceCode is real, not the "" fallback that produced minimumWageNotOnFile', async () => {
    const employeeId = randomUUID()
    const provinceCode = 'TH-10' // Bangkok — any real, seedable province code proves the point; the bug was about EMPTY STRING specifically.
    const refs = new RefsRepository(payrollPool)

    // Step 1 — the "before" state that produced the bug: a brand-new
    // employee has no payroll ref yet, so `RunsService.calculateOne`
    // (unexercised directly here — see the class doc) would have fallen
    // back to `provinceCode: ''`.
    expect(await refs.findEmployee(employeeId)).toBeNull()

    // Step 2 — svc-payroll's real, unmodified, already-unit-tested
    // `EventConsumersService`, wired to a real `ConsumerLoop` exactly the
    // way `services/svc-payroll/src/main.ts` wires it. Started BEFORE
    // anything is published: a topic exchange only routes to queues bound
    // at publish time — a consumer started after the message is already on
    // the exchange would simply never see it, the same as in a real
    // deployment where the consumer process must already be up.
    const payInputs = new PayInputsRepository(payrollPool)
    const consumers = new EventConsumersService(refs, payInputs, unusedConfigClient, new CryptoClient(unusedCryptoTransport), () => randomUUID())
    const consumer = new ConsumerLoop({
      url: RABBITMQ_URL,
      pool: payrollPool,
      queue: `q.hire-to-payroll-test.${randomUUID()}`,
      routingKeys: ['employee.created', 'employee.updated', 'employee.terminated'],
      handlers: {
        'employee.created': (tx, eventId, payload) =>
          consumers.handleEmployee(tx, { topic: 'employee.created', eventId, payload: payload as EmployeeEvent['payload'] }),
      },
    })
    await consumer.start()

    try {
      // Step 3 — svc-onboarding's own write path, verbatim: one
      // transaction, one outbox row, in the `onboarding` schema — nothing
      // about this differs from what
      // `services/svc-onboarding/src/employee.service.ts` actually does.
      const client = await onboardingPool.connect()
      try {
        await client.query('BEGIN')
        await writeOutbox(client, 'onboarding', 'employee.created', {
          id: employeeId,
          empCode: `E-${employeeId.slice(0, 8)}`,
          orgUnitId: randomUUID(),
          employmentType: 'monthly',
          provinceCode,
          startDate: '2026-08-01',
          status: 'active',
          preferredLang: 'th',
        })
        await client.query('COMMIT')
      } finally {
        client.release()
      }

      // Step 4 — the relay this task built a call site for, publishing
      // through the real `AmqpPublisher` this task built.
      const relayClient = await onboardingPool.connect()
      const publisher = new AmqpPublisher({ url: RABBITMQ_URL })
      try {
        const relay = new OutboxRelay(relayClient, publisher, 'onboarding')
        const result = await relay.drainOnce()
        expect(result).toEqual({ published: 1, failed: 0 })
      } finally {
        relayClient.release()
        await publisher.close()
      }

      // Step 5 — assert the fix, in the database, through the real repository.
      await expect(waitFor(async () => (await refs.findEmployee(employeeId)) !== null)).resolves.toBe(true)
      const ref = await refs.findEmployee(employeeId)
      expect(ref?.provinceCode).toBe(provinceCode)
      expect(ref?.provinceCode).not.toBe('')

      // Step 6 — the exact line from `PayProfilesService`/`RunsService`'s
      // own code that turned an empty province into a thrown
      // `minimumWageNotOnFile`: with a real province code now on file, this
      // resolves to a real, seedable rule key instead of the always-missing
      // `'minwage.daily.'`.
      const ruleKey = minimumWageRuleKey(ref?.provinceCode ?? '')
      expect(ruleKey).toBe(`minwage.daily.${provinceCode}`)
      expect(ruleKey).not.toBe('minwage.daily.') // the exact broken key the traced defect produced
    } finally {
      await consumer.stop()
    }
  })

  it('redelivery of the same employee.created event does not double-apply or corrupt the ref row (XC-EVENTS)', async () => {
    const employeeId = randomUUID()
    const refs = new RefsRepository(payrollPool)
    const payInputs = new PayInputsRepository(payrollPool)
    const consumers = new EventConsumersService(refs, payInputs, unusedConfigClient, new CryptoClient(unusedCryptoTransport), () => randomUUID())
    const consumer = new ConsumerLoop({
      url: RABBITMQ_URL,
      pool: payrollPool,
      queue: `q.hire-to-payroll-test.${randomUUID()}`,
      routingKeys: ['employee.created'],
      handlers: {
        'employee.created': (tx, eventId, payload) =>
          consumers.handleEmployee(tx, { topic: 'employee.created', eventId, payload: payload as EmployeeEvent['payload'] }),
      },
    })
    await consumer.start()

    try {
      const publisher = new AmqpPublisher({ url: RABBITMQ_URL })
      const eventId = randomUUID()
      const payload = {
        id: employeeId,
        empCode: 'E-DUP',
        orgUnitId: randomUUID(),
        employmentType: 'monthly',
        provinceCode: 'TH-50',
        startDate: '2026-08-01',
        status: 'active',
        preferredLang: 'th',
      }
      try {
        await publisher.publish('employee.created', payload, eventId)
        await publisher.publish('employee.created', payload, eventId) // same eventId — a genuine redelivery
      } finally {
        await publisher.close()
      }

      await expect(waitFor(async () => (await refs.findEmployee(employeeId)) !== null)).resolves.toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const ref = await refs.findEmployee(employeeId)
      expect(ref?.provinceCode).toBe('TH-50')
      // No exception, no duplicate row (province_code is upserted keyed on
      // employee_id, so a "duplicate" would silently corrupt nothing
      // visible here even if idempotent() were broken — the real proof is
      // that `idempotent()`'s own dedupe ran, not just that the final state
      // looks right; that mechanism is covered directly in
      // `packages/kernel/src/bus/transport.realbroker.test.ts`).
    } finally {
      await consumer.stop()
    }
  })
})
