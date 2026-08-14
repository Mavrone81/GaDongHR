/**
 * Port to `svc-config`'s `GET /rules/:key` — the ONLY way this service ever
 * learns a statutory or governed figure (task brief CONSTRAINTS: "No
 * statutory value hard-coded"). `sso.registration.deadline_days` (Statutory
 * Spec §5, SSA s.34) drives the M1-2 acceptance criterion: "a new hire with
 * start date D gets an SSO-registration task due D+30" — the `30` here is
 * never a literal in this service, it is whatever `svc-config` currently
 * has active for that key.
 *
 * Injectable (matching `health.controller.ts`'s `CryptoProbe` and every
 * other service-to-service port in this codebase) so tests never touch the
 * network — `testing/fake-config-client.ts` is the fake.
 */
export interface ConfigClient {
  /** Resolves to the numeric value of `ruleKey`'s currently-effective row. Throws if svc-config is unreachable or the key has no effective row — callers must not silently substitute a default. */
  getNumericRule(ruleKey: string): Promise<number>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * Real HTTP implementation: `GET {baseUrl}/rules/{ruleKey}`, the exact
 * shape `services/svc-config/src/rules.controller.ts`'s `getOne` serves.
 * Requires `config.rule.read` in production — `fetchImpl` defaults to the
 * global `fetch` (every existing test/call site keeps working unchanged)
 * but `app.module.ts` passes in `createAuthenticatedFetch(machineTokenClient)`
 * (S2S auth task) so this call carries this service's own machine bearer
 * token, the same way a human caller's browser carries theirs.
 */
export function createHttpConfigClient(baseUrl: string, fetchImpl: typeof fetch = fetch): ConfigClient {
  return {
    async getNumericRule(ruleKey: string): Promise<number> {
      const res = await fetchImpl(`${baseUrl}/rules/${encodeURIComponent(ruleKey)}`)
      if (!res.ok) throw new Error(`svc-config: GET /rules/${ruleKey} responded ${String(res.status)}`)
      const body: unknown = await res.json()
      if (!isRecord(body) || typeof body['value'] !== 'number') {
        throw new Error(`svc-config: rule "${ruleKey}" did not resolve to a numeric value`)
      }
      return body['value']
    },
  }
}
