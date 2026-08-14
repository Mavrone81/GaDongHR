/**
 * The one place `process.env.EXPO_PUBLIC_*` is read. Every other module
 * imports from here — never `process.env` directly — mirroring
 * `web/src/env.ts`'s "one audit point" rule (task brief: "Config from env,
 * not hardcoded").
 *
 * Expo inlines any `process.env.EXPO_PUBLIC_*` reference at bundle time
 * (the `EXPO_PUBLIC_` prefix is required — Expo's Metro config only
 * substitutes vars with that prefix, by design, so a server-only secret
 * can never accidentally ship in a client bundle). The exact same
 * `process.env.EXPO_PUBLIC_X` read also works unmodified under plain Node
 * (this file is imported by `scripts/integration-check.ts` via ts-node,
 * and by Jest) — one mechanism, two runtimes, no branching.
 *
 * API REALITY (task brief): production Traefik exposes only
 * `/api/config`, `/api/authz`, `/api/audit`, `/api/docs`, `/api/i18n`,
 * `/api/notify` today — attendance/timesheet/leave/payroll are not yet
 * publicly routed. Every client below therefore takes ONE configurable
 * base URL (`EXPO_PUBLIC_API_BASE_URL`, default same-origin `/api`) plus a
 * per-service PATH under it, so turning a service on in production is a
 * config change (`EXPO_PUBLIC_SVC_<X>_PATH`), never a code change.
 */

/**
 * The ONLY place `process.env[...]` is written with a literal key
 * anywhere in this file — every other read goes through this function
 * with `name` as a runtime variable. That indirection is not just style:
 * `babel-preset-expo`'s env-inlining plugin statically rewrites a LITERAL
 * `process.env.EXPO_PUBLIC_X` / `process.env['EXPO_PUBLIC_X']` reference
 * into a hard-coded value at transform time (the real, intended behaviour
 * for a shipped bundle — see this file's header). Written as a dynamic
 * `process.env[name]` lookup instead, the plugin cannot statically
 * determine which var is being read and leaves it alone, so this file
 * keeps reading the REAL, current `process.env` at call time — which is
 * what `scripts/integration-check.ts` (plain Node, no bundler at all) and
 * `env.test.ts` (mutates `process.env` per test) both require to work at
 * all.
 */
function readEnv(name: string): string | undefined {
  return process.env[name];
}

function optional(name: string, fallback: string): string {
  const value = readEnv(name);
  return value && value.length > 0 ? value : fallback;
}

function required(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`mobile: missing required env var ${name} — see mobile/.env.example`);
  }
  return value;
}

export interface ServicePaths {
  config: string;
  i18n: string;
  attendance: string;
  timesheet: string;
  leave: string;
  payroll: string;
  docs: string;
}

export interface AppConfig {
  oidcIssuer: string;
  oidcClientId: string;
  /** `expo-auth-session`'s own redirect URI, computed at runtime by `auth/oidcClient.ts` via `makeRedirectUri()` — not read from env (there is no fixed dev-server port on native the way `web`'s Vite port is; Expo AuthSession's proxy/scheme redirect is resolved per-launch). */
  oidcAudience: string;
  /** Same-origin `/api` by default — production turn-on is config only (see header). Local dev against the e2e stack overrides this per-service via `EXPO_PUBLIC_SVC_*_URL` instead, since the e2e harness exposes each service on its own port with no shared gateway. */
  apiBaseUrl: string;
  servicePaths: ServicePaths;
  /** Absolute per-service override, used for local development against `test/e2e`'s stack (no gateway — every service is its own `http://127.0.0.1:<port>`). When set for a given service, it wins over `apiBaseUrl` + the service's path. */
  serviceUrlOverrides: Partial<ServicePaths>;
}

const OVERRIDE_VAR_NAMES: Record<keyof ServicePaths, string> = {
  config: 'EXPO_PUBLIC_SVC_CONFIG_URL',
  i18n: 'EXPO_PUBLIC_SVC_I18N_URL',
  attendance: 'EXPO_PUBLIC_SVC_ATTENDANCE_URL',
  timesheet: 'EXPO_PUBLIC_SVC_TIMESHEET_URL',
  leave: 'EXPO_PUBLIC_SVC_LEAVE_URL',
  payroll: 'EXPO_PUBLIC_SVC_PAYROLL_URL',
  docs: 'EXPO_PUBLIC_SVC_DOCS_URL',
};

function overrides(): Partial<ServicePaths> {
  const out: Partial<ServicePaths> = {};
  for (const [key, varName] of Object.entries(OVERRIDE_VAR_NAMES) as Array<[keyof ServicePaths, string]>) {
    const value = readEnv(varName);
    if (value) out[key] = value;
  }
  return out;
}

export function loadConfig(): AppConfig {
  return {
    oidcIssuer: required('EXPO_PUBLIC_OIDC_ISSUER'),
    oidcClientId: optional('EXPO_PUBLIC_OIDC_CLIENT_ID', 'mobile'),
    oidcAudience: optional('EXPO_PUBLIC_OIDC_AUDIENCE', 'gadonghr-services'),
    apiBaseUrl: optional('EXPO_PUBLIC_API_BASE_URL', '/api'),
    servicePaths: {
      config: 'config',
      i18n: 'i18n',
      attendance: 'attendance',
      timesheet: 'timesheet',
      leave: 'leave',
      payroll: 'payroll',
      docs: 'docs',
    },
    serviceUrlOverrides: overrides(),
  };
}

/** Resolves the base URL a given service's `ApiClient` should call: an override if set, else `apiBaseUrl/<servicePath>`. */
export function resolveServiceUrl(config: AppConfig, service: keyof ServicePaths): string {
  const override = config.serviceUrlOverrides[service];
  if (override) return override;
  return `${config.apiBaseUrl.replace(/\/+$/, '')}/${config.servicePaths[service]}`;
}
