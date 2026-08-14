import { loadConfig, resolveServiceUrl } from './env';
import { createApiClient } from './httpClient';
import type { Locale } from '../lib/i18n/locale';

/** Mirrors `web/src/api/svcI18n.ts` exactly — `GET /bundles/:locale` is unauthenticated by design (svc-i18n's own doc: "the login screen needs its own strings ... rendered before any principal exists"). */
function isFlatStringBundle(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

export async function fetchBundle(locale: Locale): Promise<Record<string, string>> {
  const config = loadConfig();
  const client = createApiClient(resolveServiceUrl(config, 'i18n'), null);
  const body = await client.request<unknown>(`/bundles/${locale}`);
  if (!isFlatStringBundle(body)) {
    throw new Error(`svc-i18n returned an unusable bundle shape for locale "${locale}" (expected a flat object of strings): ${JSON.stringify(body)?.slice(0, 200) ?? String(body)}`);
  }
  return body;
}
