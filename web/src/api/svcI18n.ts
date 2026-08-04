import { loadConfig } from '../env'
import { createApiClient } from './httpClient'
import type { Locale } from '../i18n/locale'

// Deliberately `tokens: null` — `GET /bundles/:locale` is unauthenticated by
// design (`services/svc-i18n/src/bundles.controller.ts`'s own header: "the
// login screen needs its own strings ... rendered before any principal
// exists"). Attaching a bearer token here would be harmless but pointless.
const client = createApiClient(loadConfig().svcI18nUrl, null)

/**
 * `client.request<T>` only `JSON.parse`s and casts — it never checks that
 * the body actually matches `T`. A 200 response whose body is anything
 * other than a flat `{ key: string, ... }` map (still-nested JSON, an
 * error envelope, an array, a bare scalar, `null`) would otherwise sail
 * straight past `fetchBundle` and into `I18nContext.tsx`'s `localeBundle` /
 * `englishBundle` state as if it were good data — a *successful* fetch
 * that is nonetheless unusable. `I18nContext.tsx`'s `t()` happens to
 * degrade safely either way (a flat-key lookup on a nested object just
 * misses and falls through to `FALLBACK_EN_BUNDLE`), but silently — none
 * of the "svc-i18n unreachable" diagnostics (the one `console.warn` naming
 * the locale) fire, because nothing rejected. Validating the shape here
 * and throwing turns that silent, undiagnosable degradation into the
 * exact same rejected-promise path a network failure already takes, which
 * `I18nProvider` already warns on and falls back from — see
 * `I18nContext.test.tsx` and `App.rendersReadableText.test.tsx`.
 */
function isFlatStringBundle(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

export async function fetchBundle(locale: Locale): Promise<Record<string, string>> {
  const body = await client.request<unknown>(`/bundles/${locale}`)
  if (!isFlatStringBundle(body)) {
    throw new Error(
      `svc-i18n returned an unusable bundle shape for locale "${locale}" (expected a flat object of strings): ${JSON.stringify(body)?.slice(0, 200) ?? String(body)}`,
    )
  }
  return body
}
