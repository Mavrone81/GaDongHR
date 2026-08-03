import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DEV_BYPASS_ENABLED, loadConfig } from '../env'
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshTokenSet } from './oidcClient'
import type { OidcConfig, TokenSet } from './oidcClient'
import { randomString, codeChallengeFromVerifier } from './pkce'
import { decodeJwtPayload } from './jwt'
import type { JwtClaims } from './jwt'
import { createDevSession } from './devBypass'
import type { AuthTokenSource } from '../api/httpClient'

/**
 * SECURITY: tokens live ONLY in React state (in-memory, this module), never
 * in `localStorage`/`sessionStorage`/a cookie. `sessionStorage` below holds
 * only the transient PKCE verifier + state, cleared the moment the callback
 * completes — never a credential. Rationale (task brief): this app renders
 * salaries and national-ID-adjacent statutory data; an XSS that can read
 * `localStorage` would exfiltrate a session capable of reading them. The
 * cost is real and accepted: a page reload drops the session and forces a
 * fresh login (no silent re-hydration from storage) — see web/README.md.
 */
export type AuthStatus = 'unauthenticated' | 'authenticating' | 'authenticated'

export interface CurrentUser {
  id: string
  username: string
  /**
   * UI-ONLY convenience set, not a security boundary. Populated from a
   * `permissions` claim on the access token when present (or the
   * fabricated dev-bypass token — see `devBypass.ts`). Real Keycloak
   * tokens issued by `deploy/keycloak/realm-gadonghr.json` today carry no
   * such claim (permission grants live in svc-authz's own DB, read only
   * via `POST /decide`, which `web/ui-coverage.json` marks
   * service-to-service-only — never callable from a browser). Until a
   * `/me`-shaped endpoint or a token claim exists, a real login sees an
   * empty set here and the nav renders no gated destinations — fail-safe
   * (nothing shown), not fail-open, matching this system's own
   * deny-by-default philosophy. Every write this app makes is still
   * enforced for real by the resource server's own `PermissionGuard`
   * regardless of what this set says.
   */
  permissions: Set<string>
}

export interface AuthContextValue {
  status: AuthStatus
  currentUser: CurrentUser | null
  /** Redirects the browser to Keycloak's hosted login page (or, in dev-bypass mode, signs in locally with no redirect). */
  login: () => void
  /** Completes the authorization-code exchange for the current `window.location` query string. Call once, from the OIDC redirect-callback route. */
  handleCallback: () => Promise<void>
  logout: () => void
  /** The narrow interface `api/httpClient.ts`'s `createApiClient` consumes for the bearer header + 401 -> refresh -> re-auth path. */
  tokenSource: AuthTokenSource
}

const AuthContext = createContext<AuthContextValue | null>(null)

const PKCE_VERIFIER_KEY = 'gadonghr.pkce.verifier'
const PKCE_STATE_KEY = 'gadonghr.pkce.state'

function claimsToUser(claims: JwtClaims): CurrentUser {
  const permissions = Array.isArray(claims['permissions'])
    ? (claims['permissions'] as unknown[]).filter((p): p is string => typeof p === 'string')
    : []
  return {
    id: claims.sub ?? '',
    username: claims.preferred_username ?? claims.email ?? claims.sub ?? '',
    permissions: new Set(permissions),
  }
}

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const config = useMemo<OidcConfig>(() => {
    const cfg = loadConfig()
    return { issuer: cfg.oidcIssuer, clientId: cfg.oidcClientId, redirectUri: cfg.oidcRedirectUri }
  }, [])

  const [status, setStatus] = useState<AuthStatus>('unauthenticated')
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const tokensRef = useRef<TokenSet | null>(null)

  const applyTokens = useCallback((tokens: TokenSet | null) => {
    tokensRef.current = tokens
    if (tokens) {
      const claims = decodeJwtPayload(tokens.accessToken)
      setCurrentUser(claims ? claimsToUser(claims) : null)
      setStatus('authenticated')
    } else {
      setCurrentUser(null)
      setStatus('unauthenticated')
    }
  }, [])

  const login = useCallback(() => {
    // See env.ts's `DEV_BYPASS_ENABLED` header for why this must stay a
    // direct top-level-constant check, not a property read off a config
    // object, to actually tree-shake out of a production build.
    if (DEV_BYPASS_ENABLED) {
      applyTokens(createDevSession())
      return
    }
    setStatus('authenticating')
    void (async () => {
      const verifier = randomString()
      const state = randomString(32)
      window.sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier)
      window.sessionStorage.setItem(PKCE_STATE_KEY, state)
      const challenge = await codeChallengeFromVerifier(verifier)
      window.location.assign(buildAuthorizeUrl(config, state, challenge))
    })()
  }, [config, applyTokens])

  const handleCallback = useCallback(async () => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const returnedState = params.get('state')
    const expectedState = window.sessionStorage.getItem(PKCE_STATE_KEY)
    const verifier = window.sessionStorage.getItem(PKCE_VERIFIER_KEY)
    window.sessionStorage.removeItem(PKCE_STATE_KEY)
    window.sessionStorage.removeItem(PKCE_VERIFIER_KEY)

    if (!code || !verifier || !returnedState || returnedState !== expectedState) {
      applyTokens(null)
      return
    }
    try {
      const tokens = await exchangeCodeForTokens(config, code, verifier)
      applyTokens(tokens)
    } catch {
      applyTokens(null)
    }
  }, [config, applyTokens])

  const logout = useCallback(() => {
    applyTokens(null)
  }, [applyTokens])

  const refresh = useCallback(async (): Promise<string | null> => {
    const current = tokensRef.current
    if (!current?.refreshToken) return null
    const next = await refreshTokenSet(config, current.refreshToken)
    if (!next) return null
    applyTokens(next)
    return next.accessToken
  }, [config, applyTokens])

  const tokenSource = useMemo<AuthTokenSource>(
    () => ({
      getAccessToken: () => tokensRef.current?.accessToken ?? null,
      refresh,
      onUnauthorized: () => applyTokens(null),
    }),
    [refresh, applyTokens],
  )

  const value = useMemo<AuthContextValue>(
    () => ({ status, currentUser, login, handleCallback, logout, tokenSource }),
    [status, currentUser, login, handleCallback, logout, tokenSource],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

export { AuthContext }
