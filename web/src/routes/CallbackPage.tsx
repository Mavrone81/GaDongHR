import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'

/** `VITE_OIDC_REDIRECT_URI` (`.env.local.example`) points here — Keycloak sends the browser back with `?code=&state=` after a successful hosted login, and this route's only job is to finish the PKCE exchange (`AuthContext.handleCallback`) and leave. */
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

  return <p>{t('common.loading')}</p>
}
