/**
 * Port to `svc-config`'s `GET /rules/:key` — mirrors
 * `services/svc-onboarding/src/config-client.ts` exactly (same reasoning:
 * task CONSTRAINTS forbid hard-coding a statutory/governed figure). M4's
 * one governed figure is the face-match threshold (M4-2 acceptance
 * criterion: "false-accept rate ≤0.1% at configured threshold" — the
 * threshold itself, `attendance.match_threshold`, is never a literal in
 * this service).
 */
export interface ConfigClient {
  /** Resolves to the numeric value of `ruleKey`'s currently-effective row. Throws if svc-config is unreachable or the key has no effective row — callers must not silently substitute a default. */
  getNumericRule(ruleKey: string): Promise<number>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Real HTTP implementation: `GET {baseUrl}/rules/{ruleKey}`, the shape `services/svc-config`'s `rules.controller.ts` serves. */
export function createHttpConfigClient(baseUrl: string): ConfigClient {
  return {
    async getNumericRule(ruleKey: string): Promise<number> {
      const res = await fetch(`${baseUrl}/rules/${encodeURIComponent(ruleKey)}`)
      if (!res.ok) throw new Error(`svc-config: GET /rules/${ruleKey} responded ${String(res.status)}`)
      const body: unknown = await res.json()
      if (!isRecord(body) || typeof body['value'] !== 'number') {
        throw new Error(`svc-config: rule "${ruleKey}" did not resolve to a numeric value`)
      }
      return body['value']
    },
  }
}
