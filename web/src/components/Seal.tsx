import { useI18n } from '../i18n/I18nContext'
import './primitives.css'
import './seal.css'

/**
 * DESIGN.md's signature element: "A small red stamp attached to any figure
 * the law sets, carrying the section and the floor: `§ LPA s.32 · floor
 * 30`." `--seal` (seal red) is reserved for exactly this component —
 * "The moment it appears on something that is not a legal citation, the
 * citation stops reading as special and the direction's whole argument
 * collapses." No other component in this app may use `.seal` or
 * `var(--seal)` (`src/styles/noSealOutsideSeal.test.ts` enforces this).
 *
 * The three message shapes (`withFloor` / `withCeiling` / `plain`) reuse
 * `admin.statutoryRules.citationSeal.*` — the only citation-seal copy
 * `svc-i18n` ships today, everywhere a statutory citation is currently
 * rendered. A future non-rules screen that needs a seal with different
 * surrounding copy would add its own key there, not invent literal text
 * here.
 */
export function Seal({
  citation,
  floor,
  ceiling,
}: {
  citation: string
  floor?: unknown
  ceiling?: unknown
}): React.JSX.Element {
  const { t } = useI18n()
  const text =
    typeof floor === 'number'
      ? t('admin.statutoryRules.citationSeal.withFloor', { citation, floor })
      : typeof ceiling === 'number'
        ? t('admin.statutoryRules.citationSeal.withCeiling', { citation, ceiling })
        : t('admin.statutoryRules.citationSeal.plain', { citation })

  return <span className="seal">{text}</span>
}
