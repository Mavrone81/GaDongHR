import { useI18n } from '../i18n/I18nContext'
import './comingSoon.css'

/** Placeholder for the four `web/ui-coverage.json` screens this task does not build (task brief: "the other four come next"). Reached only via a nav link that role-driven nav already gated (`Shell.tsx`'s `NavLink`) or a direct URL a permitted user typed — `RequirePermission` (`routes/RequirePermission.tsx`) still guards it either way. */
export function ComingSoon(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="coming-soon">
      <h1 className="coming-soon__title">{t('shell.comingSoon.title')}</h1>
      <p>{t('shell.comingSoon.body')}</p>
    </div>
  )
}
