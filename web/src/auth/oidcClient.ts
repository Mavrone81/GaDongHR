export interface OidcConfig {
  issuer: string
  clientId: string
  redirectUri: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  /** Epoch milliseconds. */
  expiresAt: number
}

function authEndpoint(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/auth`
}
function tokenEndpoint(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/token`
}
export function logoutEndpoint(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/logout`
}

export function buildAuthorizeUrl(config: OidcConfig, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${authEndpoint(config.issuer)}?${params.toString()}`
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in: number
  token_type: string
}

function isTokenResponse(v: unknown): v is TokenResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>)['access_token'] === 'string' &&
    typeof (v as Record<string, unknown>)['expires_in'] === 'number'
  )
}

function toTokenSet(res: TokenResponse, now: () => number): TokenSet {
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    idToken: res.id_token ?? null,
    expiresAt: now() + res.expires_in * 1000,
  }
}

export async function exchangeCodeForTokens(
  config: OidcConfig,
  code: string,
  codeVerifier: string,
  now: () => number = Date.now,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  })
  const res = await fetch(tokenEndpoint(config.issuer), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throw new Error(`oidc: token exchange failed (${String(res.status)})`)
  const json: unknown = await res.json()
  if (!isTokenResponse(json)) throw new Error('oidc: malformed token response')
  return toTokenSet(json, now)
}

/** Refresh-token grant. Returns `null` (never throws) on any failure — the caller's job is to treat that identically to "session over, re-authenticate". */
export async function refreshTokenSet(
  config: OidcConfig,
  refreshToken: string,
  now: () => number = Date.now,
): Promise<TokenSet | null> {
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
    })
    const res = await fetch(tokenEndpoint(config.issuer), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) return null
    const json: unknown = await res.json()
    if (!isTokenResponse(json)) return null
    return toTokenSet(json, now)
  } catch {
    return null
  }
}
