import { AuditEmitter, CryptoClient, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { ConsentRepository } from './consent.repository'
import type { ConsentRecordRow, ConsentState } from './consent.repository'
import { EmployeeRepository } from './employee.repository'
import { EmployeeService } from './employee.service'
import { biometricConsentMustBeSeparate, consentFormNotFound, employeeNotFound, noGrantedConsentToWithdraw } from './onboarding-errors'

export const BIOMETRIC_PURPOSE = 'biometric'
const FORM_SNAPSHOT_FIELD = 'form_text_snapshot'

export interface ConsentDecisionInput {
  /**
   * A single purpose (`'hr_processing'`, `'biometric'`, ...) or an array.
   * PDPA-BIOMETRIC-COMPLIANCE.md §4.1 / M1-ONBOARDING §1.1: biometric
   * consent must be a SEPARATE submission from the general HR-processing
   * notice — bundling `'biometric'` together with any other purpose in one
   * array is `ONB-020`, checked before anything else in `prepareDecision`.
   */
  purpose: string | string[]
  decision: 'granted' | 'refused'
  formVersion: number
}

export interface PreparedConsentEntry {
  employeeId: string
  consentFormId: string
  purpose: string
  state: ConsentState
  langShown: string
  decidedAt: string
  formTextSnapshot: Buffer
  formVersion: number
}

export interface PreparedWithdrawal {
  employeeId: string
  consentFormId: string
  purpose: string
  langShown: string
  decidedAt: string
  formTextSnapshot: Buffer
  formVersion: number
}

function normalisePurposes(purpose: string | string[]): string[] {
  return Array.isArray(purpose) ? purpose : [purpose]
}

/**
 * Business logic behind `POST /employees/:id/consents` and
 * `DELETE /employees/:id/consents/biometric` (M1-3). No SQL here
 * (`consent.repository.ts` owns that). Follows the same prepare/commit
 * split as `EmployeeService`: `CryptoClient.encryptBatch` (the as-shown
 * form snapshot) runs BEFORE any transaction opens.
 *
 * This class is the one place PDPA-BIOMETRIC-COMPLIANCE.md §4.2's "freely
 * given" guarantee is enforced in code: a `refused` biometric decision
 * follows EXACTLY the same success path as a `granted` one — same insert,
 * same 200-class response, same absence of any adverse-flag write. The
 * only difference is which value lands in the non-adverse `clock_in_method`
 * routing column (`EmployeeService.setClockInMethod`) and whether
 * `consent.granted` is published (never for a refusal — the roadmap event
 * catalog has no `consent.refused` event: an attendance service has
 * nothing to enable on a refusal).
 */
export class ConsentService {
  constructor(
    private readonly consentRepo: ConsentRepository,
    private readonly employeeRepo: EmployeeRepository,
    private readonly employeeService: EmployeeService,
    private readonly crypto: CryptoClient,
    private readonly audit: AuditEmitter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepareDecision(employeeId: string, input: ConsentDecisionInput): Promise<PreparedConsentEntry[]> {
    const purposes = normalisePurposes(input.purpose)

    // ONB-020 — checked FIRST, before any DB read or crypto call: biometric
    // consent bundled with any other purpose in the same submission.
    if (purposes.includes(BIOMETRIC_PURPOSE) && purposes.length > 1) {
      throw biometricConsentMustBeSeparate()
    }

    const employee = await this.employeeRepo.findById(employeeId)
    if (!employee) throw employeeNotFound(employeeId)

    const decidedAt = this.now().toISOString()
    const state: ConsentState = input.decision === 'granted' ? 'granted' : 'refused'

    const prepared: PreparedConsentEntry[] = []
    for (const purpose of purposes) {
      const form = await this.consentRepo.findForm(purpose, employee.preferredLang, input.formVersion)
      if (!form) throw consentFormNotFound(purpose, employee.preferredLang, input.formVersion)

      const ciphertexts = await this.crypto.encryptBatch([
        { entityId: employeeId, field: FORM_SNAPSHOT_FIELD, value: form.bodyText, fieldClass: 'S2' },
      ])
      const formTextSnapshot = ciphertexts.get(FORM_SNAPSHOT_FIELD)
      if (!formTextSnapshot) throw new Error('ConsentService: encryptBatch did not return the form snapshot ciphertext')

      prepared.push({
        employeeId, consentFormId: form.id, purpose, state,
        langShown: employee.preferredLang, decidedAt, formTextSnapshot, formVersion: form.version,
      })
    }
    return prepared
  }

  /**
   * Inserts every prepared consent record, updates the (non-adverse)
   * clock-in routing flag for a `biometric` decision either way, and
   * publishes `consent.granted` only for a `granted` biometric-or-otherwise
   * decision — **never for a refusal**. A refusal completes this method
   * exactly as successfully as a grant does; there is no branch here that
   * can fail, flag, or otherwise penalise it.
   */
  async commitDecision(tx: Queryable, prepared: PreparedConsentEntry[], actorId: string, actorRole: string): Promise<ConsentRecordRow[]> {
    const records: ConsentRecordRow[] = []
    for (const entry of prepared) {
      const record = await this.consentRepo.insertRecord(tx, {
        employeeId: entry.employeeId, consentFormId: entry.consentFormId, purpose: entry.purpose,
        state: entry.state, langShown: entry.langShown, decidedAt: entry.decidedAt, formTextSnapshot: entry.formTextSnapshot,
      })
      records.push(record)

      if (entry.purpose === BIOMETRIC_PURPOSE) {
        await this.employeeService.setClockInMethod(tx, entry.employeeId, entry.state === 'granted' ? 'biometric' : 'alternative')
      }

      if (entry.state === 'granted') {
        await writeOutbox(tx, 'onboarding', 'consent.granted', {
          employeeId: entry.employeeId, purpose: entry.purpose, formVersion: entry.formVersion, at: entry.decidedAt,
        })
      }

      await this.audit.emit(tx, 'onboarding', {
        actorId, actorRole, action: `consent.${entry.state}`, entity: `consent.${entry.purpose}`, entityId: entry.employeeId,
      })
    }
    return records
  }

  /** `DELETE /employees/:id/consents/biometric` — one-tap withdrawal (PDPA §4.4). Requires a currently-`granted` biometric consent (ONB-024 otherwise). */
  async prepareWithdraw(employeeId: string): Promise<PreparedWithdrawal> {
    const employee = await this.employeeRepo.findById(employeeId)
    if (!employee) throw employeeNotFound(employeeId)

    const records = await this.consentRepo.findRecordsByEmployeeAndPurpose(employeeId, BIOMETRIC_PURPOSE)
    const current = records[0]
    if (!current || current.state !== 'granted') throw noGrantedConsentToWithdraw(BIOMETRIC_PURPOSE)

    const form = await this.consentRepo.findFormById(current.consentFormId)
    if (!form) throw consentFormNotFound(BIOMETRIC_PURPOSE, current.langShown, 0)

    const ciphertexts = await this.crypto.encryptBatch([
      { entityId: employeeId, field: FORM_SNAPSHOT_FIELD, value: form.bodyText, fieldClass: 'S2' },
    ])
    const formTextSnapshot = ciphertexts.get(FORM_SNAPSHOT_FIELD)
    if (!formTextSnapshot) throw new Error('ConsentService: encryptBatch did not return the form snapshot ciphertext')

    return {
      employeeId, consentFormId: form.id, purpose: BIOMETRIC_PURPOSE,
      langShown: current.langShown, decidedAt: this.now().toISOString(), formTextSnapshot, formVersion: form.version,
    }
  }

  async commitWithdraw(tx: Queryable, prepared: PreparedWithdrawal, actorId: string, actorRole: string): Promise<ConsentRecordRow> {
    const record = await this.consentRepo.insertRecord(tx, {
      employeeId: prepared.employeeId, consentFormId: prepared.consentFormId, purpose: prepared.purpose,
      state: 'withdrawn', langShown: prepared.langShown, decidedAt: prepared.decidedAt, formTextSnapshot: prepared.formTextSnapshot,
    })

    await this.employeeService.setClockInMethod(tx, prepared.employeeId, 'alternative')

    await writeOutbox(tx, 'onboarding', 'consent.withdrawn', {
      employeeId: prepared.employeeId, purpose: prepared.purpose, formVersion: prepared.formVersion, at: prepared.decidedAt,
    })

    await this.audit.emit(tx, 'onboarding', {
      actorId, actorRole, action: 'consent.withdrawn', entity: `consent.${prepared.purpose}`, entityId: prepared.employeeId,
    })

    return record
  }

  async currentState(employeeId: string, purpose: string): Promise<ConsentState | null> {
    const records = await this.consentRepo.findRecordsByEmployeeAndPurpose(employeeId, purpose)
    return records[0]?.state ?? null
  }
}
