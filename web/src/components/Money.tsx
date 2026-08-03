import { formatTHB } from '@gadong/kernel/dist/i18n/format'
import { useI18n } from '../i18n/I18nContext'

/**
 * Renders `bigint` satang via the kernel's own `formatTHB` — DESIGN.md's
 * "Non-negotiables": "No statutory value ... computed in React" extends to
 * formatting too. This component never touches a `number`; the prop type
 * itself (`bigint`) makes a float path a compile error, not a review
 * comment.
 */
export function Money({ satang }: { satang: bigint }): React.JSX.Element {
  const { locale } = useI18n()
  return <span className="numeric">{formatTHB(satang, locale)}</span>
}
