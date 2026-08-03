import { loadConfig } from '../env'
import { createApiClient } from './httpClient'
import type { Locale } from '../i18n/locale'

// Deliberately `tokens: null` — `GET /bundles/:locale` is unauthenticated by
// design (`services/svc-i18n/src/bundles.controller.ts`'s own header: "the
// login screen needs its own strings ... rendered before any principal
// exists"). Attaching a bearer token here would be harmless but pointless.
const client = createApiClient(loadConfig().svcI18nUrl, null)

export async function fetchBundle(locale: Locale): Promise<Record<string, string>> {
  return client.request<Record<string, string>>(`/bundles/${locale}`)
}
