import type { Queryable } from '@gadong/kernel'

export type ConsentState = 'granted' | 'refused' | 'withdrawn'

export interface ConsentFormRow {
  id: string
  purpose: string
  lang: string
  version: number
  bodyText: string
}

export interface ConsentRecordRow {
  id: string
  employeeId: string
  consentFormId: string
  purpose: string
  state: ConsentState
  langShown: string
  decidedAt: string
  /** 🔐 as-shown snapshot ciphertext — never plaintext outside `ConsentService`. */
  formTextSnapshot: Buffer
}

export interface NewConsentRecordRow {
  employeeId: string
  consentFormId: string
  purpose: string
  state: ConsentState
  langShown: string
  decidedAt: string
  formTextSnapshot: Buffer
}

const FORM_SELECT_COLUMNS = 'id, purpose, lang, version, body_text'
const RECORD_SELECT_COLUMNS = 'id, employee_id, consent_form_id, purpose, state, lang_shown, decided_at, form_text_snapshot'

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`ConsentRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function toBuffer(v: unknown, field: string): Buffer {
  if (Buffer.isBuffer(v)) return v
  throw new Error(`ConsentRepository: expected ${field} to be a Buffer (bytea), got ${typeof v}`)
}

function mapForm(row: Record<string, unknown>): ConsentFormRow {
  return { id: String(row['id']), purpose: String(row['purpose']), lang: String(row['lang']), version: Number(row['version']), bodyText: String(row['body_text']) }
}

function mapRecord(row: Record<string, unknown>): ConsentRecordRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    consentFormId: String(row['consent_form_id']),
    purpose: String(row['purpose']),
    state: row['state'] as ConsentState,
    langShown: String(row['lang_shown']),
    decidedAt: toIsoString(row['decided_at']),
    formTextSnapshot: toBuffer(row['form_text_snapshot'], 'form_text_snapshot'),
  }
}

/**
 * SQL for `onboarding.consent_form` (versioned, published notice text — not
 * 🔐, see the migration's header for why) and `onboarding.consent_record`
 * (🔐 per-decision snapshot of what was actually shown). `insertRecord`
 * takes the CALLER's transaction handle `tx` so a decision and its
 * `consent.granted`/`consent.withdrawn` outbox event
 * (`consent.service.ts`) commit or roll back together (ADR-005).
 *
 * `consent_record` is append-only by convention here (never UPDATEd) —
 * PDPA-BIOMETRIC-COMPLIANCE.md §4.3 requires the full decision history
 * (grant → refuse → withdraw → re-grant, in any order) to remain
 * reconstructable, not just the latest state.
 */
export class ConsentRepository {
  constructor(private readonly db: Queryable) {}

  async findForm(purpose: string, lang: string, version: number): Promise<ConsentFormRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${FORM_SELECT_COLUMNS} FROM onboarding.consent_form WHERE purpose = $1 AND lang = $2 AND version = $3`,
      [purpose, lang, version],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapForm(rows[0]) : null
  }

  /** Used by one-tap withdrawal (`ConsentService.prepareWithdraw`) to recover the form version of the consent being withdrawn — the withdrawal event payload (`consent.withdrawn`) carries `formVersion`. */
  async findFormById(id: string): Promise<ConsentFormRow | null> {
    const { rows } = await this.db.query(`SELECT ${FORM_SELECT_COLUMNS} FROM onboarding.consent_form WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapForm(rows[0]) : null
  }

  async insertRecord(tx: Queryable, row: NewConsentRecordRow): Promise<ConsentRecordRow> {
    const { rows } = await tx.query(
      `INSERT INTO onboarding.consent_record (employee_id, consent_form_id, purpose, state, lang_shown, decided_at, form_text_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${RECORD_SELECT_COLUMNS}`,
      [row.employeeId, row.consentFormId, row.purpose, row.state, row.langShown, row.decidedAt, row.formTextSnapshot],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ConsentRepository.insertRecord: INSERT ... RETURNING produced no row')
    return mapRecord(inserted)
  }

  /** Every record for `employeeId`/`purpose`, most recent decision first — the caller (`ConsentService`) derives "current state" as `[0]`. */
  async findRecordsByEmployeeAndPurpose(employeeId: string, purpose: string): Promise<ConsentRecordRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${RECORD_SELECT_COLUMNS} FROM onboarding.consent_record WHERE employee_id = $1 AND purpose = $2 ORDER BY decided_at DESC`,
      [employeeId, purpose],
    )
    return rows.map(mapRecord)
  }
}
