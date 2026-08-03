import { formatDate } from '@gadong/kernel/dist/i18n/format'
import { useI18n } from '../i18n/I18nContext'

/**
 * Renders one ISO-8601 date via the kernel's own `formatDate` — Thai
 * renders พ.ศ. (Buddhist Era, C.E. + 543), English and Chinese render
 * Gregorian unchanged. See `Money.tsx`'s header for why this delegates
 * rather than reimplementing the offset here.
 */
export function DateText({ iso }: { iso: string }): React.JSX.Element {
  const { locale } = useI18n()
  return <span className="numeric">{formatDate(iso, locale)}</span>
}
