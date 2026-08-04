import type { PayrollRunRow } from './runs.repository'

/**
 * Outbound event payloads, factored out so `events.test.ts` can assert
 * their shape without a database or a transaction — the same pattern
 * `services/svc-claims/src/events.ts` established.
 *
 * THE ONE RULE THESE PAYLOADS EXIST TO ENFORCE: no amounts, ever. The
 * roadmap's delivery contract is that payloads carry no S3-class plaintext
 * and a consumer needing a sensitive field fetches it by id through the
 * owning service's audited API. Payroll is the service with the most to
 * leak — put a net figure in `payroll.committed` and every salary in the
 * company sits in cleartext in the outbox table and in the broker. So
 * `payroll.committed` carries a COUNT of employees, and `payslip.issued`
 * carries an id and a language.
 */

export interface PayrollCommittedPayload {
  runId: string
  period: string
  runType: string
  employeeCount: number
}

export function buildPayrollCommittedPayload(run: PayrollRunRow, employeeCount: number): PayrollCommittedPayload {
  return { runId: run.id, period: run.period, runType: run.runType, employeeCount }
}

export interface PayslipIssuedPayload {
  payslipId: string
  runId: string
  employeeId: string
  lang: string
}

export function buildPayslipIssuedPayload(payslipId: string, runId: string, employeeId: string, lang: string): PayslipIssuedPayload {
  return { payslipId, runId, employeeId, lang }
}

export const TOPIC_PAYROLL_COMMITTED = 'payroll.committed'
export const TOPIC_PAYSLIP_ISSUED = 'payslip.issued'
