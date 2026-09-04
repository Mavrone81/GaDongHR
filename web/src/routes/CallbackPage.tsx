import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { CarapaceMark } from '../components/CarapaceMark'
import './loginPage.css'

/**
 * `VITE_OIDC_REDIRECT_URI` (`.env.local.example`) points here — Keycloak
 * sends the browser back with `?code=&state=` after a successful hosted
 * login, and this route's only job is to finish the PKCE exchange
 * (`AuthContext.handleCallback`) and leave.
 *
 * It renders the same sheet as `LoginPage` rather than a bare paragraph.
 * This screen sits between two designed pages — ours, then Keycloak's,
 * then this — and for the length of a token exchange it was an unstyled
 * line of text in the top-left corner of a blank viewport, which reads as
 * a broken page rather than a step in a flow. The brand mark is the point:
 * it says "still the same site" while the exchange completes.
 */
export function CallbackPage(): React.JSX.Element {
  const { handleCallback } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()

  useEffect(() => {
    // Runs once, on mount — `handleCallback`/`navigate` are stable across
    // this component's single-purpose lifetime, and re-running the
    // exchange on every render would redeem an already-spent code.
    void handleCallback().then(() => navigate('/', { replace: true }))
    // (no react-hooks/exhaustive-deps rule is configured in this repo's
    // eslint.config.js, so no disable directive is needed here — the
    // empty dependency array is intentional regardless, see comment above.)
  }, [])

  return (
    <div className="login-page">
      <div className="login-page__sheet">
        <div className="login-page__brand">
          <CarapaceMark tone="reversed" size={44} title={t('shell.brandMark.alt')} />
          <p className="login-page__wordmark">
            <span className="login-page__wordmark-ga">{t('shell.brandMark.wordmarkGadong')}</span>
            <span className="login-page__wordmark-hr">{t('shell.brandMark.wordmarkHr')}</span>
          </p>
        </div>

        {/* `role="status"` so a screen reader hears that something is in
            progress; without it this page is silent for the whole exchange. */}
        <p className="login-page__title" role="status">
          {t('auth.callback.signingIn')}
        </p>
      </div>
    </div>
  )
}
