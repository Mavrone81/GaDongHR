import { Link, Outlet } from 'react-router-dom'
import { useI18n } from '../i18n/I18nContext'
import { SUPPORTED_LOCALES } from '../i18n/locale'
import { useAuth } from '../auth/AuthContext'
import { useHasPermission } from '../auth/permissions'
import { NAV_DESTINATIONS } from './navigation'

function NavLink({ destination }: { destination: (typeof NAV_DESTINATIONS)[number] }): React.JSX.Element | null {
  const { t } = useI18n()
  const reachable = useHasPermission(destination.permission)
  // Role-driven navigation (task brief): a destination the caller's
  // permissions do not reach is not rendered at all — not disabled, not
  // greyed out, absent — so a user never sees an affordance for an action
  // the server would 403.
  if (!reachable) return null
  return <Link to={destination.path}>{t(destination.labelKey)}</Link>
}

export function Shell(): React.JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const { currentUser, logout } = useAuth()

  return (
    <div>
      <header>
        <span className="eyebrow">{t('shell.brand')}</span>
        <nav aria-label={t('shell.brand')}>
          {NAV_DESTINATIONS.map((d) => (
            <NavLink key={d.path} destination={d} />
          ))}
        </nav>
        <div role="group">
          {SUPPORTED_LOCALES.map((l) => (
            <button key={l} type="button" aria-pressed={l === locale} onClick={() => setLocale(l)}>
              {t(`shell.locale.${l}`)}
            </button>
          ))}
        </div>
        {currentUser && (
          <button type="button" onClick={logout}>
            {t('auth.logout')}
          </button>
        )}
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
