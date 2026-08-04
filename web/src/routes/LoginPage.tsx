import { useI18n } from '../i18n/I18nContext'
import { useAuth } from '../auth/AuthContext'
import { SUPPORTED_LOCALES } from '../i18n/locale'
import { CarapaceMark } from '../components/CarapaceMark'
import { Button } from '../components/Button'
import './loginPage.css'

/**
 * Real login: clicking through here redirects to Keycloak's own hosted
 * login page (authorization-code + PKCE, see `auth/AuthContext.tsx`) — this
 * component itself never collects a password. `reason="expired"` is what a
 * 401 surviving a refresh attempt renders (`App.tsx`'s `AuthGate`) — "a 401
 * triggers re-auth, not a blank screen" (task brief), using the exact
 * `auth.session.expired` copy `services/svc-i18n/bundles/*.json` already
 * ships for this.
 *
 * This is also the FIRST screen every user sees, before any authenticated
 * shell chrome exists — so it is the only place a not-yet-signed-in,
 * Thai-speaking factory worker can change language at all (task brief: the
 * shell's own switcher, `routes/Shell.tsx`, only renders after sign-in).
 * The language switcher below is deliberately placed above the sign-in
 * action, not tucked into a footer, and uses the same `SUPPORTED_LOCALES` /
 * `setLocale` the shell uses — selecting a locale here re-renders this page
 * immediately (no reload) and persists via `i18n/locale.ts`'s
 * `storeLocale`, so the choice carries into the authenticated app too.
 */
export function LoginPage({ reason }: { reason?: 'expired' }): React.JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const { login, status } = useAuth()

  const host = typeof window !== 'undefined' ? window.location.hostname : ''

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

        <p className="login-page__statement">{t('auth.login.statement')}</p>

        <h1 className="login-page__title">{reason === 'expired' ? t('auth.session.expired') : t('auth.login.title')}</h1>

        <div className="login-page__locale" role="group" aria-label={t('shell.locale.chooseLanguage')}>
          {SUPPORTED_LOCALES.map((l) => (
            <Button
              key={l}
              variant="quiet"
              className="login-page__locale-btn"
              aria-pressed={l === locale}
              onClick={() => setLocale(l)}
            >
              {t(`shell.locale.${l}`)}
            </Button>
          ))}
        </div>

        <Button
          variant="primary"
          className="login-page__submit"
          onClick={login}
          disabled={status === 'authenticating'}
        >
          {status === 'authenticating' ? t('common.loading') : t('auth.login.submit')}
        </Button>

        <p className="login-page__footer">{t('auth.login.footer', { host })}</p>
      </div>
    </div>
  )
}
