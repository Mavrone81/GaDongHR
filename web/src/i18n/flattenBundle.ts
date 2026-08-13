export type FlatBundle = Record<string, string>

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Mirrors `services/svc-i18n/src/flatten.ts` exactly — this app owns both
 * `web/src/i18n/` and `services/svc-i18n/bundles/` (see this file's sibling
 * `fallbackBundle.ts`), and the two shapes it reconciles are identical:
 * nested JSON `{ "shell": { "brand": "..." } }`, as translators/reviewers
 * want to read it, in; dotted `"shell.brand" -> "..."`, the exact string
 * every `t('shell.brand')` call site passes, out. Used once, at module
 * load, to flatten `fallbackBundle.th.json` into `FALLBACK_BUNDLE` — see
 * `fallbackBundle.ts`. Throws on anything that isn't ultimately a string
 * leaf or a plain object, naming the exact offending path, rather than
 * shipping `[object Object]` as a "translation".
 */
export function flattenBundle(value: unknown, path = ''): FlatBundle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`web: fallback bundle value at "${path || '(root)'}" must be a string or an object, got ${describeType(value)}`)
  }

  const result: FlatBundle = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key
    if (typeof child === 'string') {
      result[childPath] = child
    } else if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      Object.assign(result, flattenBundle(child, childPath))
    } else {
      throw new Error(`web: fallback bundle leaf at "${childPath}" must be a string, got ${describeType(child)}`)
    }
  }
  return result
}
