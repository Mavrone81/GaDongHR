export type FlatBundle = Record<string, string>;

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Ported from `web/src/i18n/flattenBundle.ts` (same semantics, task
 * brief) — mirrors `services/svc-i18n/src/flatten.ts`: nested JSON
 * `{ "shell": { "brand": "..." } }`, as translators/reviewers want to read
 * it, in; dotted `"shell.brand" -> "..."`, the exact string every
 * `t('shell.brand')` call site passes, out. svc-i18n's own
 * `GET /bundles/:locale` already flattens server-side before responding
 * (`services/svc-i18n/src/bundles.controller.ts` returns `FlatBundle`
 * directly), so this function is used ONLY to flatten the bundled
 * `fallbackBundle.th.json` at module load (`fallbackBundle.ts`) — the one
 * nested JSON this app ever sees. Throws on anything that isn't ultimately
 * a string leaf or a plain object, naming the exact offending path, rather
 * than shipping `[object Object]` as a "translation".
 */
export function flattenBundle(value: unknown, path = ''): FlatBundle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`mobile: bundle value at "${path || '(root)'}" must be a string or an object, got ${describeType(value)}`);
  }

  const result: FlatBundle = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (typeof child === 'string') {
      result[childPath] = child;
    } else if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      Object.assign(result, flattenBundle(child, childPath));
    } else {
      throw new Error(`mobile: bundle leaf at "${childPath}" must be a string, got ${describeType(child)}`);
    }
  }
  return result;
}
