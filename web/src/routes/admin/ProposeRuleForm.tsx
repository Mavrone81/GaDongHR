import { useState } from 'react'
import type { FormEvent } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { ApiError } from '../../api/httpClient'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import type { GovernanceClass, ProposeRuleInput, StatutoryRuleRow } from '../../api/svcConfig'
import { FloorViolationNotice } from './FloorViolationNotice'
import { Eyebrow } from '../../components/Eyebrow'
import { Field } from '../../components/Field'
import { Button } from '../../components/Button'
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
    <form className="propose-form" onSubmit={(e) => void handleSubmit(e)}>
      <Eyebrow>{t('admin.statutoryRules.propose.title')}</Eyebrow>

      {envelope && <FloorViolationNotice envelope={envelope} />}
      {success && <p>{t('admin.statutoryRules.propose.success')}</p>}

      <Field label={t('admin.statutoryRules.propose.ruleKey')} htmlFor="propose-rule-key">
        <input id="propose-rule-key" value={ruleKey} onChange={(e) => setRuleKey(e.target.value)} required />
      </Field>

      <Field label={t('admin.statutoryRules.propose.value')} htmlFor="propose-value" numeric>
        <input id="propose-value" className="numeric" value={value} onChange={(e) => setValue(e.target.value)} required />
      </Field>

      <Field label={t('admin.statutoryRules.propose.unit')} htmlFor="propose-unit">
        <input id="propose-unit" value={unit} onChange={(e) => setUnit(e.target.value)} required />
      </Field>

      <Field label={t('admin.statutoryRules.propose.citation')} htmlFor="propose-citation">
        <input id="propose-citation" value={citation} onChange={(e) => setCitation(e.target.value)} required />
      </Field>

      <Field label={t('admin.statutoryRules.propose.governanceClass')} htmlFor="propose-governance-class">
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
      </Field>

      {governanceClass === 'STATUTORY_FLOOR' && (
        <Field label={t('admin.statutoryRules.propose.statutoryFloor')} htmlFor="propose-floor" numeric>
          <input
            id="propose-floor"
            className="numeric"
            value={statutoryFloor}
            onChange={(e) => setStatutoryFloor(e.target.value)}
          />
        </Field>
      )}

      <Field label={t('admin.statutoryRules.propose.effectiveFrom')} htmlFor="propose-effective-from">
        <input
          id="propose-effective-from"
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          required
        />
      </Field>

      <Field label={t('admin.statutoryRules.propose.reason')} htmlFor="propose-reason">
        <input id="propose-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </Field>

      <p className="propose-form__actions">
        <Button type="submit" variant="primary" disabled={submitting}>
          {t('admin.statutoryRules.propose.submit')}
        </Button>{' '}
        <Button type="button" variant="quiet" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </p>
    </form>
  )
}
