import { Controller, Get, HttpException, Param, Query } from '@nestjs/common'
import { GadongError, buildHealth } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
import { BundlesService } from './bundles.service'
import type { MissingKeyCounts } from './bundles.service'
import type { FlatBundle } from './flatten'

/** `I18N-404` — the requested locale is not one of `th`/`en`/`zh` (case-sensitive: `TH`, `th-TH` and `fr` all land here too). Distinct from the fallback chain inside `BundlesService`, which only ever engages for a *key* missing within a *supported* locale. */
function localeNotSupported(locale: string): GadongError {
  return new GadongError('I18N-404', 'i18n.error.locale_not_supported', 404, [{ locale }])
}

export interface I18nHealthPayload extends HealthPayload {
  missingKeys: MissingKeyCounts
}

/**
 * `GET /bundles/:locale`, `GET /glossary` and `GET /health` are
 * deliberately unauthenticated — no `@RequirePermission`, and (see
 * `app.module.ts`) no `PermissionGuard` mounted as `APP_GUARD` at all. The
 * login screen needs its own strings ("Username", "Password", "Sign in")
 * rendered before any principal exists to hold a token, so gating this
 * service behind a permission check would make the login screen unable to
 * render itself. This is the same kind of deliberate, documented exception
 * `svc-crypto` (service-to-service only) and `svc-authz` (it IS the
 * permission decision — it cannot depend on itself) each carry, for a
 * third, distinct reason: unauthenticated-by-necessity, not
 * unauthenticated-by-oversight.
 */
@Controller()
export class BundlesController {
  constructor(private readonly bundles: BundlesService) {}

  @Get('bundles/:locale')
  getBundle(@Param('locale') locale: string, @Query('ns') ns?: string): FlatBundle {
    if (!BundlesService.isSupportedLocale(locale)) {
      throw new HttpException(localeNotSupported(locale).toEnvelope(), 404)
    }
    return this.bundles.getBundle(locale, ns)
  }

  @Get('glossary')
  getGlossary(): { terms: Array<{ key: string; en: string; th: string; zh: string }> } {
    return { terms: this.bundles.getGlossary() }
  }

  @Get('health')
  health(): I18nHealthPayload {
    // No dependencies to probe (no DB, no outbound calls at boot) — an
    // empty `dependencies` map means `buildHealth` always reports `ok`
    // here; the thing actually worth surfacing is bundle completeness,
    // added alongside it (Task 10 brief: "`/health` reports the count of
    // missing keys per locale, so the gap is measurable rather than
    // discovered by a user").
    return { ...buildHealth('svc-i18n', {}), missingKeys: this.bundles.getMissingKeyCounts() }
  }
}
