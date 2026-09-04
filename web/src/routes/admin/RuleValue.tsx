import { useI18n } from '../../i18n/I18nContext'

/**
 * Renders a statutory rule's `value`, which is `unknown` by design:
 * svc-config stores whatever shape the rule needs. Most are scalars
 * (`hours.regular.max_per_day` = 8), but plenty are not —
 * `holidays.public.2026` is an array of holiday objects,
 * `hours.break.min_after` and every `pit.bracket.*` are objects.
 *
 * The screen previously rendered all of them with `String(value)`, so
 * every non-scalar rule displayed the literal text `[object Object]` —
 * for the 2026 holiday list, twenty-six of them stacked down the page.
 * That is not a formatting blemish: the PIT brackets, the OT multiplier
 * table and the holiday calendar are precisely the figures a compliance
 * reviewer opens this screen to check, and they were the ones rendered
 * unreadable.
 *
 * Structured values collapse to a one-line summary with a native
 * `<details>` disclosure. Native rather than a `useState` toggle because
 * it is keyboard-operable and screen-reader-announced for free, and
 * because a page holding fifty of these should not hold fifty pieces of
 * component state.
 *
 * Recursive: a nested object inside an array item renders through this
 * same component, so depth costs nothing and no shape can reintroduce
 * `[object Object]`.
 */
export function RuleValue({ value }: { value: unknown }): React.JSX.Element {
  const { t } = useI18n()

  if (value === null || value === undefined) {
    return <span className="rule-value rule-value--empty">{t('admin.statutoryRules.value.empty')}</span>
  }

  if (typeof value === 'boolean') {
    return <span className="rule-value">{t(value ? 'common.yes' : 'common.no')}</span>
  }

  if (typeof value === 'number' || typeof value === 'string') {
    return <span className="rule-value numeric">{String(value)}</span>
  }

  if (Array.isArray(value)) {
    return (
      <details className="rule-value rule-value__disclosure">
        <summary className="rule-value__summary">{t('admin.statutoryRules.value.entries', { count: value.length })}</summary>
        <ol className="rule-value__list">
          {value.map((item, i) => (
            /*
             * Index as key: statutory list entries carry no id of their
             * own, and position IS their identity (holiday #3 of 2026).
             * The list is replaced wholesale on reload and never reordered
             * or spliced in place, so the usual index-key hazard — React
             * reusing the wrong element after a reorder — cannot arise.
             */
            <li key={i} className="rule-value__item">
              <RuleValue value={item} />
            </li>
          ))}
        </ol>
      </details>
    )
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      return <span className="rule-value rule-value--empty">{t('admin.statutoryRules.value.empty')}</span>
    }
    return (
      <details className="rule-value rule-value__disclosure">
        <summary className="rule-value__summary">{t('admin.statutoryRules.value.fields', { count: entries.length })}</summary>
        <dl className="rule-value__fields">
          {entries.map(([key, nested]) => (
            <div key={key} className="rule-value__field">
              <dt className="rule-value__field-name">{key}</dt>
              <dd className="rule-value__field-value">
                <RuleValue value={nested} />
              </dd>
            </div>
          ))}
        </dl>
      </details>
    )
  }

  // Unreachable for JSON-derived data (bigint/symbol/function cannot survive
  // JSON.parse), but `unknown` admits them and a blank cell would be a worse
  // answer than a visible one.
  return <span className="rule-value numeric">{String(value)}</span>
}
