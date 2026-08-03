import { useState } from 'react'
import type { FormEvent } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { ApiError } from '../../api/httpClient'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import type { GovernanceClass, ProposeRuleInput, StatutoryRuleRow } from '../../api/svcConfig'
import { FloorViolationNotice } from './FloorViolationNotice'
import './statutoryRules.css'

const GOVERNANCE_CLASSES: GovernanceClass[] = ['STATUTORY_FLOOR', 'STATUTORY_FIXED', 'COMPANY_POLICY']

export function ProposeRuleForm({
  proposedBy,
  onPropose,
  onProposed,
  onCancel,
}: {
  proposedBy: string
  onPropose: (input: ProposeRuleInput) => Promise<StatutoryRuleRow>
  onProposed: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [ruleKey, setRuleKey] = useState('')
  const [value, setValue] = useState('')
  const [unit, setUnit] = useState('')
  const [citation, setCitation] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [reason, setReason] = useState('')
  const [governanceClass, setGovernanceClass] = useState<GovernanceClass>('STATUTORY_FLOOR')
  const [statutoryFloor, setStatutoryFloor] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setSubmitting(true)
    setEnvelope(null)
    setSuccess(false)
    const numericValue = value.trim() === '' ? value : Number(value)
    const input: ProposeRuleInput = {
      ruleKey,
      value: Number.isNaN(numericValue) ? value : numericValue,
      unit,
      citation,
      effectiveFrom,
      reason,
      governanceClass,
      proposedBy,
      statutoryFloor:
        governanceClass === 'STATUTORY_FLOOR' && statutoryFloor.trim() !== '' ? Number(statutoryFloor) : undefined,
    }
    try {
      await onPropose(input)
      setSuccess(true)
      onProposed()
    } catch (err) {
      if (err instanceof ApiError && err.envelope) {
        setEnvelope(err.envelope)
      } else {
        throw err
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <p className="eyebrow">{t('admin.statutoryRules.propose.title')}</p>

      {envelope && <FloorViolationNotice envelope={envelope} />}
      {success && <p>{t('admin.statutoryRules.propose.success')}</p>}

      <div className="field-row">
        <label htmlFor="propose-rule-key">{t('admin.statutoryRules.propose.ruleKey')}</label>
        <input id="propose-rule-key" value={ruleKey} onChange={(e) => setRuleKey(e.target.value)} required />
      </div>

      <div className="field-row">
        <label htmlFor="propose-value">{t('admin.statutoryRules.propose.value')}</label>
        <input id="propose-value" className="numeric" value={value} onChange={(e) => setValue(e.target.value)} required />
      </div>

      <div className="field-row">
        <label htmlFor="propose-unit">{t('admin.statutoryRules.propose.unit')}</label>
        <input id="propose-unit" value={unit} onChange={(e) => setUnit(e.target.value)} required />
      </div>

      <div className="field-row">
        <label htmlFor="propose-citation">{t('admin.statutoryRules.propose.citation')}</label>
        <input id="propose-citation" value={citation} onChange={(e) => setCitation(e.target.value)} required />
      </div>

      <div className="field-row">
        <label htmlFor="propose-governance-class">{t('admin.statutoryRules.propose.governanceClass')}</label>
        <select
          id="propose-governance-class"
          value={governanceClass}
          onChange={(e) => setGovernanceClass(e.target.value as GovernanceClass)}
        >
          {GOVERNANCE_CLASSES.map((gc) => (
            <option key={gc} value={gc}>
              {t(`admin.statutoryRules.governanceClass.${gc}`)}
            </option>
          ))}
        </select>
      </div>

      {governanceClass === 'STATUTORY_FLOOR' && (
        <div className="field-row">
          <label htmlFor="propose-floor">{t('admin.statutoryRules.propose.statutoryFloor')}</label>
          <input
            id="propose-floor"
            className="numeric"
            value={statutoryFloor}
            onChange={(e) => setStatutoryFloor(e.target.value)}
          />
        </div>
      )}

      <div className="field-row">
        <label htmlFor="propose-effective-from">{t('admin.statutoryRules.propose.effectiveFrom')}</label>
        <input
          id="propose-effective-from"
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          required
        />
      </div>

      <div className="field-row">
        <label htmlFor="propose-reason">{t('admin.statutoryRules.propose.reason')}</label>
        <input id="propose-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </div>

      <p>
        <button type="submit" disabled={submitting}>
          {t('admin.statutoryRules.propose.submit')}
        </button>{' '}
        <button type="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </p>
    </form>
  )
}
