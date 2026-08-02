import { formatDate, formatTHB } from '@gadong/kernel'
import type { Locale } from '@gadong/kernel'
import { missingMergeFields } from './errors'

/**
 * Every user-visible string in a rendered document comes from the template
 * (`templates/*.html`, I18N-GUIDE.md §1 rule 1 — "no hard-coded user-visible
 * strings"); TypeScript's only job is resolving *data* — dates and money —
 * into their locale-correct rendered form, via the kernel's formatters
 * (`packages/kernel/src/i18n/format.ts`), never reimplemented here. `date`
 * carries the raw ISO-8601 string so the Buddhist Era conversion happens at
 * the very last step, per `format.ts`'s own contract ("render-only ...
 * never store the result").
 */
export type MergeFieldValue = { type: 'text'; value: string } | { type: 'date'; iso: string } | { type: 'money'; satang: string }

export type MergeFields = Record<string, MergeFieldValue>

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Resolves every merge field to its final display string for `locale` — Buddhist Era dates on `th`, Gregorian on `en`/`zh` (kernel `formatDate`); THB grouping via kernel `formatTHB`. `text` values are HTML-escaped; the other two are not, because their output alphabet (digits, `/`, `,`, `.`, `฿`, `-`) contains no HTML metacharacters. */
export function resolveMergeFields(fields: MergeFields, locale: Locale): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, field] of Object.entries(fields)) {
    switch (field.type) {
      case 'text':
        out[key] = escapeHtml(field.value)
        break
      case 'date':
        out[key] = formatDate(field.iso, locale)
        break
      case 'money':
        out[key] = formatTHB(BigInt(field.satang), locale)
        break
    }
  }
  return out
}

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Substitutes every `{{token}}` in `html` from `resolved`. Throws `DOC-422` (`missingMergeFields`) if the template references a token the caller never supplied — a legal document must never ship with a literal `{{token}}` left in it. */
export function substituteTemplate(html: string, resolved: Record<string, string>, kind: string, lang: string): string {
  const missing = new Set<string>()
  const out = html.replace(TOKEN_PATTERN, (match, key: string) => {
    const value = resolved[key]
    if (value === undefined) {
      missing.add(key)
      return match
    }
    return value
  })
  if (missing.size > 0) throw missingMergeFields(kind, lang, [...missing])
  return out
}
