/**
 * The `{code, message_i18n_key, details}` envelope every `GadongError`
 * serialises to (`packages/kernel/src/errors.ts`'s `toEnvelope()`). This
 * shape is duplicated here deliberately (not imported from `@gadong/kernel`
 * — `GadongError` itself is a class, not a wire type, and this app only
 * ever receives the JSON, never constructs one) rather than trusted to be
 * `unknown`, so a floor/ceiling rejection's `details[0]` can be read with a
 * type, not a cast at every call site.
 */
export interface ApiErrorEnvelope {
  code: string
  message_i18n_key: string
  details: unknown[]
}

export class ApiError extends Error {
  readonly status: number
  readonly envelope: ApiErrorEnvelope | null

  constructor(status: number, envelope: ApiErrorEnvelope | null) {
    super(envelope ? `${envelope.code}: ${envelope.message_i18n_key}` : `HTTP ${String(status)}`)
    this.name = 'ApiError'
    this.status = status
    this.envelope = envelope
  }
}

/**
 * The only thing `httpClient` needs from `AuthContext` — kept as a narrow
 * interface (matching the house `AuthzTransport`/`WarnLogger` convention in
 * `@gadong/kernel`) so the 401 -> refresh -> retry -> re-auth path is
 * testable with a fake, no real OIDC/network involved.
 */
export interface AuthTokenSource {
  getAccessToken(): string | null
  /** Attempts a silent refresh; resolves the new access token, or `null` if refresh failed/there is no refresh token. */
  refresh(): Promise<string | null>
  /** Called exactly once a 401 survives a refresh attempt — the caller's job is to drop the session and route to the login screen (never to leave the user on a blank screen). */
  onUnauthorized(): void
}

async function safeEnvelope(res: Response): Promise<ApiErrorEnvelope | null> {
  try {
    const data: unknown = await res.json()
    if (
      data !== null &&
      typeof data === 'object' &&
      'code' in data &&
      'message_i18n_key' in data &&
      'details' in data
    ) {
      return data as ApiErrorEnvelope
    }
    return null
  } catch {
    return null
  }
}

export interface ApiClient {
  request<T>(path: string, init?: RequestInit): Promise<T>
}

/**
 * `tokens: null` builds an unauthenticated client — the exact shape
 * `svc-i18n`'s `/bundles/:locale` needs (`ui-coverage.json`: "the app reads
 * this to render every string on every screen, INCLUDING the login screen
 * before a principal exists"). Every other service's client passes a real
 * `AuthTokenSource`.
 */
export function createApiClient(baseUrl: string, tokens: AuthTokenSource | null): ApiClient {
  async function doFetch(path: string, init: RequestInit | undefined, token: string | null): Promise<Response> {
    const headers = new Headers(init?.headers)
    headers.set('Accept', 'application/json')
    if (init?.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const normalizedPath = path.replace(/^\/+/, '')
    return fetch(`${baseUrl.replace(/\/+$/, '')}/${normalizedPath}`, { ...init, headers })
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = tokens?.getAccessToken() ?? null
    let res = await doFetch(path, init, token)

    if (res.status === 401 && tokens) {
      const refreshed = await tokens.refresh()
      res = await doFetch(path, init, refreshed)
      if (res.status === 401) {
        const envelope = await safeEnvelope(res)
        tokens.onUnauthorized()
        throw new ApiError(401, envelope)
      }
    }

    if (!res.ok) {
      throw new ApiError(res.status, await safeEnvelope(res))
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  return { request }
}
