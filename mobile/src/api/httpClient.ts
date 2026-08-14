/**
 * Ported from `web/src/api/httpClient.ts` — identical `{code,
 * message_i18n_key, details}` error envelope, identical 401 -> refresh ->
 * retry -> re-auth contract, identical `AuthTokenSource` shape, so every
 * per-service client below (svcAttendance, svcTimesheet, svcLeave,
 * svcPayroll, svcI18n) reads exactly like its web counterpart. `fetch` is
 * a global in the Hermes/React Native runtime (and in Node 22+, for
 * `scripts/integration-check.ts`) — no polyfill needed either place.
 */
export interface ApiErrorEnvelope {
  code: string;
  message_i18n_key: string;
  details: unknown[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly envelope: ApiErrorEnvelope | null;

  constructor(status: number, envelope: ApiErrorEnvelope | null) {
    super(envelope ? `${envelope.code}: ${envelope.message_i18n_key}` : `HTTP ${String(status)}`);
    this.name = 'ApiError';
    this.status = status;
    this.envelope = envelope;
  }
}

export interface AuthTokenSource {
  getAccessToken(): string | null;
  refresh(): Promise<string | null>;
  onUnauthorized(): void;
}

async function safeEnvelope(res: Response): Promise<ApiErrorEnvelope | null> {
  try {
    const data: unknown = await res.json();
    if (data !== null && typeof data === 'object' && 'code' in data && 'message_i18n_key' in data && 'details' in data) {
      return data as ApiErrorEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ApiClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

/** `tokens: null` builds an unauthenticated client (svc-i18n's `/bundles/:locale`, reachable before sign-in — same rationale as web). Every other service's client passes a real `AuthTokenSource`. */
export function createApiClient(baseUrl: string, tokens: AuthTokenSource | null): ApiClient {
  async function doFetch(path: string, init: RequestInit | undefined, token: string | null): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    if (init?.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const normalizedPath = path.replace(/^\/+/, '');
    return fetch(`${baseUrl.replace(/\/+$/, '')}/${normalizedPath}`, { ...init, headers });
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = tokens?.getAccessToken() ?? null;
    let res = await doFetch(path, init, token);

    if (res.status === 401 && tokens) {
      const refreshed = await tokens.refresh();
      res = await doFetch(path, init, refreshed);
      if (res.status === 401) {
        const envelope = await safeEnvelope(res);
        tokens.onUnauthorized();
        throw new ApiError(401, envelope);
      }
    }

    if (!res.ok) {
      throw new ApiError(res.status, await safeEnvelope(res));
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return { request };
}
