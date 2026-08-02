/**
 * Bundle files are nested JSON — `{ "leave": { "request": { "submit": "..." } } }`
 * — because that is how translators and reviewers want to read them (grouped
 * by module). Everything downstream of loading (lookup, fallback, parity
 * checking) wants the dotted key form instead — `"leave.request.submit"` —
 * because that is the exact string every call site passes
 * (`t('leave.request.submit')`), per I18N-GUIDE.md §1 rule 1: "namespaced
 * per module: `leave.request.submit`". This is the one place the two shapes
 * are reconciled.
 */
export type FlatBundle = Record<string, string>

/**
 * Recursively walks a parsed bundle JSON value and produces a flat
 * `"a.b.c" -> "value"` map. Throws on anything that isn't ultimately a
 * string leaf or a plain object — a bundle author who accidentally puts a
 * number, array, or `null` in a bundle gets a build-time error naming the
 * exact offending path, not a `[object Object]` rendered to a factory
 * worker at runtime.
 */
export function flattenBundle(value: unknown, path = ''): FlatBundle {
  // A string leaf is handled by the caller (the loop below, or the
  // top-level bundle files themselves must be an object) — reaching here
  // with a string means `value` was passed as the *root*, which is not a
  // valid bundle shape, so it falls through to the object-shape check
  // below and throws naming "(root)".
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`svc-i18n: bundle value at "${path || '(root)'}" must be a string or an object, got ${describe(value)}`)
  }

  const result: FlatBundle = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key
    if (typeof child === 'string') {
      result[childPath] = child
    } else if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      Object.assign(result, flattenBundle(child, childPath))
    } else {
      throw new Error(`svc-i18n: bundle leaf at "${childPath}" must be a string, got ${describe(child)}`)
    }
  }
  return result
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
