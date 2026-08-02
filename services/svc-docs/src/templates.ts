import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { templateNotFound } from './errors'

export interface TemplateResolution {
  html: string
  /** The language actually used — equal to the requested `lang` unless a fallback happened, in which case it is `'en'`. */
  lang: string
  fellBack: boolean
}

/** The subset of Nest's `Logger`/`console` this loader needs — injectable so a test can assert the fallback warning was actually logged. */
export interface WarnLogger {
  warn(message: string): void
}

/**
 * Resolves `templates/<kind>.<lang>.html`, falling back to
 * `templates/<kind>.en.html` — and logging a warning — when the requested
 * language's template does not exist (I18N-GUIDE.md §1 rule 1: "Missing key
 * ⇒ English fallback + logged warning"). Real filesystem reads: the
 * templates this loader reads are files this service ships in its own
 * image (`templates/`), not a remote/database dependency this environment
 * lacks — unlike Postgres/MinIO/a browser, there is nothing to fake here.
 */
export class TemplateLoader {
  constructor(private readonly templatesDir: string) {}

  resolve(kind: string, lang: string, logger: WarnLogger = console): TemplateResolution {
    const requestedPath = join(this.templatesDir, `${kind}.${lang}.html`)
    if (existsSync(requestedPath)) {
      return { html: readFileSync(requestedPath, 'utf8'), lang, fellBack: false }
    }

    const fallbackPath = join(this.templatesDir, `${kind}.en.html`)
    if (!existsSync(fallbackPath)) throw templateNotFound(kind, lang)

    logger.warn(`svc-docs: no template for kind="${kind}" lang="${lang}" — falling back to "en" (${fallbackPath})`)
    return { html: readFileSync(fallbackPath, 'utf8'), lang: 'en', fellBack: true }
  }
}
