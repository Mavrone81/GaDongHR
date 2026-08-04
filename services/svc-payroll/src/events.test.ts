import { TOPIC_PAYROLL_COMMITTED, TOPIC_PAYSLIP_ISSUED, buildPayrollCommittedPayload, buildPayslipIssuedPayload } from './events'
import type { PayrollRunRow } from './runs.repository'

/**
 * The outbound payloads, asserted directly — the same pattern
 * `services/svc-claims/src/events.ts` established.
 *
 * The property that matters is a negative one: NO AMOUNTS. The roadmap's
 * delivery contract says payloads carry no S3-class plaintext, and payroll
 * is the service with the most to leak. A net figure in `payroll.committed`
 * would sit in cleartext in the outbox table and in the broker for every
 * employee in the company at once — which would defeat encrypt-before-write
 * through a side door, exactly as the Task 5 review found the audit emitter
 * doing with raw before/after objects.
 */

const run: PayrollRunRow = {
  id: 'run-1',
  period: '2026-10',
  runType: 'regular',
  timesheetLockVersion: 7,
  status: 'committed',
  preparedBy: 'preparer',
  approvedBy: 'approver',
  reviewedBy: 'preparer',
  rulepackVersions: { 'sso.wage.ceiling': { effectiveFrom: '2026-01-01', citation: 'x' } },
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  payDate: '2026-10-31',
  approvedAt: '2026-11-01T00:00:00.000Z',
  committedAt: '2026-11-01T00:00:00.000Z',
  adjustsRunId: null,
}

describe('payroll.committed', () => {
  it('matches the roadmap event catalog: runId, period, runType, employeeCount', () => {
    expect(buildPayrollCommittedPayload(run, 42)).toEqual({ runId: 'run-1', period: '2026-10', runType: 'regular', employeeCount: 42 })
  })

  it('carries a COUNT, never a figure — the payload has no money field of any kind', () => {
    const payload = buildPayrollCommittedPayload(run, 42)
    const keys = Object.keys(payload)
    expect(keys).not.toEqual(expect.arrayContaining(['gross', 'net', 'total', 'amount', 'amountThb']))
    expect(keys).toHaveLength(4)
  })

  it('DEMONSTRATION: the "no money field" assertion FAILS against a payload that carries one', () => {
    const leaky = { ...buildPayrollCommittedPayload(run, 42), totalNetThb: '1234567.89' }
    expect(() => {
      expect(Object.keys(leaky)).toHaveLength(4)
    }).toThrow()
  })

  it('does not leak employee identities either — a consumer that needs them fetches through the audited API', () => {
    expect(JSON.stringify(buildPayrollCommittedPayload(run, 42))).not.toContain('employeeId')
  })
})

describe('payslip.issued', () => {
  it('carries the ids and the language a notification needs, and nothing more', () => {
    expect(buildPayslipIssuedPayload('slip-1', 'run-1', 'emp-1', 'th')).toEqual({
      payslipId: 'slip-1',
      runId: 'run-1',
      employeeId: 'emp-1',
      lang: 'th',
    })
  })

  it('the language travels with the event so svc-notify addresses the employee in their own language', () => {
    expect(buildPayslipIssuedPayload('s', 'r', 'e', 'zh').lang).toBe('zh')
  })
})

describe('topic names match the roadmap event catalog exactly', () => {
  it('a typo here silently routes to nowhere on a topic exchange', () => {
    expect(TOPIC_PAYROLL_COMMITTED).toBe('payroll.committed')
    expect(TOPIC_PAYSLIP_ISSUED).toBe('payslip.issued')
  })
})
