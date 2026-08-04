import type { Queryable } from '@gadong/kernel'

export type BiometricConsentState = 'granted' | 'withdrawn'

export interface ConsentStateRow {
  employeeId: string
  state: BiometricConsentState
  updatedAt: string
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`ConsentStateRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): ConsentStateRow {
  return {
    employeeId: String(row['employee_id']),
    state: row['state'] as BiometricConsentState,
    updatedAt: toIsoString(row['updated_at']),
  }
}

/**
 * SQL for `attendance.biometric_consent` — this service's own read model of
 * "does this employee currently have biometric consent granted", fed
 * idempotently by `consent.granted`/`consent.withdrawn`
 * (`consent-event.handler.ts`). `M4-1`'s enrolment gate
 * (`EnrolmentService.startEnrolment`) reads this; it is deliberately NOT a
 * cross-schema query into `onboarding.consent_record` (disallowed by
 * convention — every service's DB role can see only its own schema).
 */
export class ConsentStateRepository {
  constructor(private readonly db: Queryable) {}

  /** Upsert — current state only, not history (the full grant/refuse/withdraw ledger lives in `onboarding.consent_record`). */
  async upsert(tx: Queryable, employeeId: string, state: BiometricConsentState, updatedAt: string): Promise<ConsentStateRow> {
    const { rows } = await tx.query(
      `INSERT INTO attendance.biometric_consent (employee_id, state, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
       RETURNING employee_id, state, updated_at`,
      [employeeId, state, updatedAt],
    )
    const row = rows[0]
    if (row === undefined) throw new Error('ConsentStateRepository.upsert: INSERT ... RETURNING produced no row')
    return mapRow(row)
  }

  async find(employeeId: string): Promise<ConsentStateRow | null> {
    const { rows } = await this.db.query(
      `SELECT employee_id, state, updated_at FROM attendance.biometric_consent WHERE employee_id = $1`,
      [employeeId],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** `true` iff the employee's current, latest-known state is `granted`. Anyone with no row on file (never granted) or a `withdrawn` row is NOT gated in. */
  async isGranted(employeeId: string): Promise<boolean> {
    const row = await this.find(employeeId)
    return row?.state === 'granted'
  }
}
