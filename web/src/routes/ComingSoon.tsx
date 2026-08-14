import { useI18n } from '../i18n/I18nContext'
import './comingSoon.css'

/** The catch-all screen for a path with no route at all (`App.tsx`'s `path="*"`) — every one of `web/ui-coverage.json`'s five declared screens now has a real screen behind it (see `routes/navigation.ts`'s header), so this component's only remaining job is "an unknown URL under the shell renders something readable, never a blank screen," not standing in for unbuilt scope. */
export function ComingSoon(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="coming-soon">
      <h1 className="coming-soon__title">{t('shell.comingSoon.title')}</h1>
      <p>{t('shell.comingSoon.body')}</p>
    </div>
  )
}
