import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locale } from '@gadong/kernel'

/** `templates/<kind>.<lang>.json` on disk — never a hard-coded user-visible string in TypeScript (Task 11 brief). */
export interface NotifyTemplate {
  subject: string
  body: string
}

export interface RenderedMessage {
  subject: string
  body: string
}

/** Injectable so tests can assert on the exact warning without touching `console` (mirrors the rest of the kernel's injectable-transport style). */
export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void
}

export const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(message, meta ?? {}),
}

/** English is the one locale every `<kind>` is required to ship — the fallback of last resort has to exist unconditionally. */
const FALLBACK_LOCALE: Locale = 'en'

const DEFAULT_TEMPLATES_DIR = join(__dirname, '..', 'templates')

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** `{{key}}` substitution only — no expressions, no conditionals. A placeholder with no matching var is left as literal text rather than silently dropped, so a wiring bug in the caller is visible in the rendered message instead of producing a template with a word missing. */
export function substitute(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole: string, key: string) => vars[key] ?? whole)
}

/**
 * Loads and renders `templates/<kind>.<lang>.json`. A template missing for
 * the recipient's language falls back to English and logs a warning naming
 * the template and language (Task 11 brief, "Tests that carry this
 * service") — it never throws for a missing non-English template, because a
 * worker must still receive SOMETHING rather than lose the notification
 * entirely over a translation gap. Only a missing English template (the
 * fallback itself) is a genuine configuration error and throws.
 */
export class TemplateRenderer {
  constructor(
    private readonly logger: Logger = consoleLogger,
    private readonly templatesDir: string = DEFAULT_TEMPLATES_DIR,
  ) {}

  /** Returns the template to render with plus which locale it actually came from — the caller (`NotifyService`) uses `effectiveLang` for both the stored `notification.lang` and any date/money formatting, so a fallback to English never mixes an English subject with a Buddhist-Era date. */
  load(kind: string, lang: Locale): { template: NotifyTemplate; effectiveLang: Locale } {
    const preferred = this.readTemplate(kind, lang)
    if (preferred) return { template: preferred, effectiveLang: lang }

    if (lang === FALLBACK_LOCALE) {
      throw new Error(`svc-notify: no template found for kind=${JSON.stringify(kind)} lang=${JSON.stringify(lang)} (this IS the fallback locale — nothing left to fall back to)`)
    }

    this.logger.warn('svc-notify: template missing for recipient language, falling back to English', { kind, lang })
    const fallback = this.readTemplate(kind, FALLBACK_LOCALE)
    if (!fallback) {
      throw new Error(`svc-notify: no template found for kind=${JSON.stringify(kind)} in requested lang=${JSON.stringify(lang)} or fallback lang=${JSON.stringify(FALLBACK_LOCALE)}`)
    }
    return { template: fallback, effectiveLang: FALLBACK_LOCALE }
  }

  render(template: NotifyTemplate, vars: Readonly<Record<string, string>>): RenderedMessage {
    return { subject: substitute(template.subject, vars), body: substitute(template.body, vars) }
  }

  private readTemplate(kind: string, lang: Locale): NotifyTemplate | null {
    const path = join(this.templatesDir, `${kind}.${lang}.json`)
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed) || typeof parsed['subject'] !== 'string' || typeof parsed['body'] !== 'string') {
      throw new Error(`svc-notify: malformed template at ${path} — expected {subject: string, body: string}`)
    }
    return { subject: parsed['subject'], body: parsed['body'] }
  }
}
