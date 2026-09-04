import { useCallback, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { useHasPermission } from '../../auth/permissions'
import { useSvcOnboarding } from '../../api/svcOnboarding'
import { ApiError } from '../../api/httpClient'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import { Button } from '../../components/Button'
import './onboarding.css'

/** The consent form version this screen presents. Recorded with every decision so a later change to the notice text can never be mistaken for agreement to the new wording. */
const FORM_VERSION = 1

/**
 * PDPA consent capture, and the single most compliance-sensitive control
 * in the product.
 *
 * PDPA-BIOMETRIC-COMPLIANCE.md §4.1 and M1-ONBOARDING §1.1 require
 * biometric consent to be a SEPARATE submission from the general
 * HR-processing notice. svc-onboarding enforces that server-side —
 * bundling `'biometric'` with any other purpose in one array is `ONB-020`,
 * checked before anything else — and this panel is built so the UI cannot
 * express the illegal shape in the first place: two independent sections,
 * two independent submissions, and no combined "accept all" control
 * anywhere. A single checkbox covering both would be the exact dark
 * pattern the separation rule exists to prevent.
 *
 * Refusal is a first-class action, not the absence of one. Both purposes
 * offer an explicit Refuse button that records a `refused` decision — UAT
 * pack U2 requires a working refusal path, and PDPA requires refusal be as
 * easy to give as agreement. An employee who refuses biometrics is
 * onboarded normally and clocks in by an alternative method; nothing here
 * blocks on it.
 */
export function ConsentPanel({ employeeId, onChanged }: { employeeId: string; onChanged: () => void }): React.JSX.Element | null {
  const { t } = useI18n()
  const onboarding = useSvcOnboarding()
  const canConsent = useHasPermission('consent.self')
  const [pending, setPending] = useState<string | null>(null)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)
  const [recorded, setRecorded] = useState<string | null>(null)

  const submit = useCallback(
    (purpose: string, decision: 'granted' | 'refused') => {
      const key = `${purpose}:${decision}`
      setPending(key)
      setEnvelope(null)
      setRecorded(null)
      onboarding
        .submitConsent(employeeId, { purpose, decision, formVersion: FORM_VERSION })
        .then(() => {
          setRecorded(key)
          onChanged()
        })
        .catch((err: unknown) => {
          setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null)
        })
        .finally(() => setPending(null))
    },
    [employeeId, onboarding, onChanged],
  )

  if (!canConsent) return null

  const section = (purpose: string, titleKey: string, bodyKey: string) => (
    <div className="consent-section">
      <h3 className="consent-section__title">{t(titleKey)}</h3>
      <p className="consent-section__body">{t(bodyKey)}</p>
      <p className="consent-section__actions">
        <Button variant="primary" onClick={() => submit(purpose, 'granted')} disabled={pending !== null}>
          {pending === `${purpose}:granted` ? t('common.loading') : t('onboarding.consent.grant')}
        </Button>{' '}
        <Button variant="quiet" onClick={() => submit(purpose, 'refused')} disabled={pending !== null}>
          {pending === `${purpose}:refused` ? t('common.loading') : t('onboarding.consent.refuse')}
        </Button>
      </p>
      {recorded?.startsWith(`${purpose}:`) && (
        <p className="consent-section__recorded" role="status">
          {recorded.endsWith(':granted') ? t('onboarding.consent.recordedGranted') : t('onboarding.consent.recordedRefused')}
        </p>
      )}
    </div>
  )

  return (
    <section className="onboarding-consent">
      <h2 className="onboarding-section-title">{t('onboarding.consent.title')}</h2>
      <p className="onboarding-consent__note">{t('onboarding.consent.separateNote')}</p>

      {section('hr_processing', 'onboarding.consent.hrProcessing.title', 'onboarding.consent.hrProcessing.body')}
      {section('biometric', 'onboarding.consent.biometric.title', 'onboarding.consent.biometric.body')}

      {envelope && <p className="onboarding-error">{t(envelope.message_i18n_key)}</p>}
    </section>
  )
}
