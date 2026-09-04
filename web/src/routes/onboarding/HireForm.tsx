import { useCallback, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { useSvcOnboarding } from '../../api/svcOnboarding'
import type { CreateEmployeeInput, EmploymentType, Lang } from '../../api/svcOnboarding'
import { ApiError } from '../../api/httpClient'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import { Field } from '../../components/Field'
import { Button } from '../../components/Button'
import './onboarding.css'

const EMPLOYMENT_TYPES: EmploymentType[] = ['monthly', 'daily', 'hourly', 'contract']
const LANGS: Lang[] = ['th', 'en', 'zh']

function emptyInput(): CreateEmployeeInput {
  return {
    empCode: '',
    firstNameTh: '',
    lastNameTh: '',
    firstNameEn: '',
    lastNameEn: '',
    nationalId: '',
    taxId: '',
    ssoNumber: '',
    bankAccount: '',
    bankCode: '',
    dob: '',
    address: { houseNo: '', subDistrict: '', district: '', province: '', postalCode: '' },
    phone: '',
    email: '',
    employmentType: 'monthly',
    orgUnitId: '',
    positionId: '',
    provinceCode: '',
    startDate: '',
    preferredLang: 'th',
  }
}

/**
 * The M1 hire form. Every field here is one svc-onboarding requires; the
 * validation that matters (Thai national-ID checksum, duplicate national
 * ID, statutory probation bounds) is enforced server-side and surfaced
 * through the error envelope rather than reimplemented in the browser —
 * "no UI-side business logic, ever" (roadmap, Phase 1.5 rule 2). A second
 * national-ID checksum here would be a second implementation to drift.
 *
 * Note what this form does NOT collect: any consent. PDPA compliance
 * requires consent be captured as its own deliberate act with its own
 * form version, separately from the employment record, and biometric
 * consent separately again from that — so it lives on the employee's own
 * screen after the record exists, never as a checkbox at the bottom of a
 * hiring form.
 */
export function HireForm({ onHired, onCancel }: { onHired: () => void; onCancel: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const onboarding = useSvcOnboarding()
  const [input, setInput] = useState<CreateEmployeeInput>(emptyInput)
  const [saving, setSaving] = useState(false)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)

  const set = useCallback(<K extends keyof CreateEmployeeInput>(key: K, value: CreateEmployeeInput[K]) => {
    setInput((prev) => ({ ...prev, [key]: value }))
  }, [])

  const setAddress = useCallback((key: keyof CreateEmployeeInput['address'], value: string) => {
    setInput((prev) => ({ ...prev, address: { ...prev.address, [key]: value } }))
  }, [])

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault()
      setSaving(true)
      setEnvelope(null)
      onboarding
        .createEmployee(input)
        .then(() => onHired())
        .catch((err: unknown) => {
          setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null)
        })
        .finally(() => setSaving(false))
    },
    [input, onboarding, onHired],
  )

  return (
    <form className="panel hire-form" onSubmit={handleSubmit}>
      <h2 className="hire-form__title">{t('onboarding.hire.title')}</h2>

      <div className="hire-form__grid">
        <Field label={t('onboarding.hire.empCode')} htmlFor="hire-empCode">
          <input id="hire-empCode" required value={input.empCode} onChange={(e) => set('empCode', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.firstNameTh')} htmlFor="hire-firstNameTh">
          <input id="hire-firstNameTh" required value={input.firstNameTh} onChange={(e) => set('firstNameTh', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.lastNameTh')} htmlFor="hire-lastNameTh">
          <input id="hire-lastNameTh" required value={input.lastNameTh} onChange={(e) => set('lastNameTh', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.firstNameEn')} htmlFor="hire-firstNameEn">
          <input id="hire-firstNameEn" required value={input.firstNameEn} onChange={(e) => set('firstNameEn', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.lastNameEn')} htmlFor="hire-lastNameEn">
          <input id="hire-lastNameEn" required value={input.lastNameEn} onChange={(e) => set('lastNameEn', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.nameZh')} htmlFor="hire-nameZh">
          <input id="hire-nameZh" value={input.nameZh ?? ''} onChange={(e) => set('nameZh', e.target.value)} />
        </Field>

        <Field label={t('onboarding.hire.nationalId')} htmlFor="hire-nationalId">
          <input id="hire-nationalId" required inputMode="numeric" value={input.nationalId} onChange={(e) => set('nationalId', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.taxId')} htmlFor="hire-taxId">
          <input id="hire-taxId" required inputMode="numeric" value={input.taxId} onChange={(e) => set('taxId', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.ssoNumber')} htmlFor="hire-ssoNumber">
          <input id="hire-ssoNumber" value={input.ssoNumber ?? ''} onChange={(e) => set('ssoNumber', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.bankCode')} htmlFor="hire-bankCode">
          <input id="hire-bankCode" required value={input.bankCode} onChange={(e) => set('bankCode', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.bankAccount')} htmlFor="hire-bankAccount">
          <input id="hire-bankAccount" required inputMode="numeric" value={input.bankAccount} onChange={(e) => set('bankAccount', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.dob')} htmlFor="hire-dob">
          <input id="hire-dob" type="date" required value={input.dob} onChange={(e) => set('dob', e.target.value)} />
        </Field>

        <Field label={t('onboarding.hire.phone')} htmlFor="hire-phone">
          <input id="hire-phone" required type="tel" value={input.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.email')} htmlFor="hire-email">
          <input id="hire-email" required type="email" value={input.email} onChange={(e) => set('email', e.target.value)} />
        </Field>

        <Field label={t('onboarding.hire.houseNo')} htmlFor="hire-houseNo">
          <input id="hire-houseNo" required value={input.address.houseNo} onChange={(e) => setAddress('houseNo', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.subDistrict')} htmlFor="hire-subDistrict">
          <input id="hire-subDistrict" required value={input.address.subDistrict} onChange={(e) => setAddress('subDistrict', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.district')} htmlFor="hire-district">
          <input id="hire-district" required value={input.address.district} onChange={(e) => setAddress('district', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.province')} htmlFor="hire-province">
          <input id="hire-province" required value={input.address.province} onChange={(e) => setAddress('province', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.postalCode')} htmlFor="hire-postalCode">
          <input id="hire-postalCode" required inputMode="numeric" value={input.address.postalCode} onChange={(e) => setAddress('postalCode', e.target.value)} />
        </Field>

        <Field label={t('onboarding.hire.employmentType')} htmlFor="hire-employmentType">
          <select id="hire-employmentType" value={input.employmentType} onChange={(e) => set('employmentType', e.target.value as EmploymentType)}>
            {EMPLOYMENT_TYPES.map((v) => (
              <option key={v} value={v}>
                {t(`onboarding.employmentType.${v}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('onboarding.hire.orgUnitId')} htmlFor="hire-orgUnitId">
          <input id="hire-orgUnitId" required value={input.orgUnitId} onChange={(e) => set('orgUnitId', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.positionId')} htmlFor="hire-positionId">
          <input id="hire-positionId" required value={input.positionId} onChange={(e) => set('positionId', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.provinceCode')} htmlFor="hire-provinceCode">
          <input id="hire-provinceCode" required value={input.provinceCode} onChange={(e) => set('provinceCode', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.startDate')} htmlFor="hire-startDate">
          <input id="hire-startDate" type="date" required value={input.startDate} onChange={(e) => set('startDate', e.target.value)} />
        </Field>
        <Field label={t('onboarding.hire.probationEndDate')} htmlFor="hire-probationEndDate">
          <input
            id="hire-probationEndDate"
            type="date"
            value={input.probationEndDate ?? ''}
            onChange={(e) => set('probationEndDate', e.target.value)}
          />
        </Field>
        <Field label={t('onboarding.hire.preferredLang')} htmlFor="hire-preferredLang">
          <select id="hire-preferredLang" value={input.preferredLang} onChange={(e) => set('preferredLang', e.target.value as Lang)}>
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {t(`shell.locale.${l}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {envelope && <p className="onboarding-error">{t(envelope.message_i18n_key)}</p>}

      <p className="panel__actions">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? t('common.loading') : t('onboarding.hire.submit')}
        </Button>{' '}
        <Button type="button" variant="quiet" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </p>
    </form>
  )
}
