import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RawBundles } from './bundles.service'

/**
 * svc-i18n owns no database schema (Task 10 brief: "svc-i18n owns NO
 * database schema, so there is no repository or migration layer") — the
 * bundles are plain JSON files at `services/svc-i18n/bundles/{th,en,zh}.json`,
 * read once at process boot. `bundlesDir` defaults to the directory that
 * sits next to the compiled output: once built, `__dirname` is
 * `services/svc-i18n/dist`, and the Dockerfile (matching `svc-config`'s
 * `seed/` pattern) copies `bundles/` alongside `dist/`, so `../bundles`
 * resolves the same way in a container as it does from `ts-node`/tests run
 * from `src/`.
 */
export function loadRawBundles(bundlesDir: string = join(__dirname, '..', 'bundles')): RawBundles {
  const readLocale = (locale: 'th' | 'en' | 'zh'): unknown => {
    const path = join(bundlesDir, `${locale}.json`)
    const text = readFileSync(path, 'utf-8')
    return JSON.parse(text) as unknown
  }
  return { th: readLocale('th'), en: readLocale('en'), zh: readLocale('zh') }
}
