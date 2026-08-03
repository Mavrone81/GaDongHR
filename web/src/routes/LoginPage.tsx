import { useI18n } from '../i18n/I18nContext'
import { useAuth } from '../auth/AuthContext'

/**
 * Real login: clicking through here redirects to Keycloak's own hosted
 * login page (authorization-code + PKCE, see `auth/AuthContext.tsx`) — this
 * component itself never collects a password. `reason="expired"` is what a
 * 401 surviving a refresh attempt renders (`App.tsx`'s `AuthGate`) — "a 401
 * triggers re-auth, not a blank screen" (task brief), using the exact
 * `auth.session.expired` copy `services/svc-i18n/bundles/*.json` already
 * ships for this.
 */
export function LoginPage({ reason }: { reason?: 'expired' }): React.JSX.Element {
  const { t } = useI18n()
  const { login, status } = useAuth()

  return (
    <div>
      <p className="eyebrow">{t('shell.brand')}</p>
      <h1>{reason === 'expired' ? t('auth.session.expired') : t('auth.login.title')}</h1>
      <button type="button" onClick={login} disabled={status === 'authenticating'}>
        {status === 'authenticating' ? t('common.loading') : t('auth.login.submit')}
      </button>
    </div>
  )
}
