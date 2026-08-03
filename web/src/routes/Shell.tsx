import { NavLink, Outlet } from 'react-router-dom'
import { useI18n } from '../i18n/I18nContext'
import { SUPPORTED_LOCALES } from '../i18n/locale'
import { useAuth } from '../auth/AuthContext'
import { useHasPermission } from '../auth/permissions'
import { NAV_DESTINATIONS } from './navigation'
import { Eyebrow } from '../components/Eyebrow'
import { Button } from '../components/Button'
import './shell.css'

function NavItem({ destination }: { destination: (typeof NAV_DESTINATIONS)[number] }): React.JSX.Element | null {
  const { t } = useI18n()
  const reachable = useHasPermission(destination.permission)
  // Role-driven navigation (task brief): a destination the caller's
  // permissions do not reach is not rendered at all — not disabled, not
  // greyed out, absent — so a user never sees an affordance for an action
  // the server would 403.
  if (!reachable) return null
  return (
    <li className="shell-nav__item">
      <NavLink to={destination.path} className={({ isActive }) => `shell-nav__link${isActive ? ' active' : ''}`}>
        {t(destination.labelKey)}
      </NavLink>
    </li>
  )
}

export function Shell(): React.JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const { currentUser, logout } = useAuth()

  return (
    <div>
      <header className="shell-header">
        <Eyebrow as="span">{t('shell.brand')}</Eyebrow>
        <nav aria-label={t('shell.brand')} className="shell-nav-wrap">
          <ul className="shell-nav">
            {NAV_DESTINATIONS.map((d) => (
              <NavItem key={d.path} destination={d} />
            ))}
          </ul>
        </nav>
        <div className="shell-locale" role="group">
          {SUPPORTED_LOCALES.map((l) => (
            <Button
              key={l}
              variant="quiet"
              className="shell-locale__btn"
              aria-pressed={l === locale}
              onClick={() => setLocale(l)}
            >
              {t(`shell.locale.${l}`)}
            </Button>
          ))}
        </div>
        {currentUser && (
          <Button variant="quiet" onClick={logout}>
            {t('auth.logout')}
          </Button>
        )}
      </header>
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  )
}
