import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DEV_BYPASS_ENABLED, loadConfig } from '../env'
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshTokenSet } from './oidcClient'
import type { OidcConfig, TokenSet } from './oidcClient'
import { randomString, codeChallengeFromVerifier } from './pkce'
import { decodeJwtPayload } from './jwt'
import type { JwtClaims } from './jwt'
import { createDevSession } from './devBypass'
import { fetchPermissions } from './permissions'
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
   * UI-ONLY convenience set, not a security boundary. Seeded from a
   * `permissions` claim on the access token when one is present (the
   * fabricated dev-bypass token carries one — see `devBypass.ts`), then
   * replaced by svc-authz's `GET /me/permissions` once that call returns.
   *
   * Real Keycloak tokens from `deploy/keycloak/realm-gadonghr.json` carry
   * no such claim and are not expected to: permission grants live in
   * svc-authz's own DB, and a claim would freeze them into a token that
   * outlives a revoked grant. The `/me` endpoint is therefore the real
   * source here, and the claim is only a dev-bypass affordance.
   *
   * Historically that endpoint did not exist, so a real login saw an
   * empty set, every gated nav destination was hidden, and every
   * `RequirePermission` route rendered nothing — fail-safe rather than
   * fail-open, but it made the admin UI unreachable in production for
   * three weeks before anyone completed a login to notice.
   *
   * Still not a security boundary: every read and write this app makes is
   * enforced independently by the resource server's own
   * `PermissionGuard`, regardless of what this set says.
   */
  permissions: Set<string>
}

/**
 * Why a sign-in did not complete, when the reason is something the user
 * can act on. `denied` is Keycloak refusing or the user cancelling at the
 * hosted login page (`?error=access_denied`); `failed` covers everything
 * else — a rejected code exchange, a malformed token response, or a
 * `state` that does not match the one this tab stored.
 *
 * Before this existed all three outcomes called `applyTokens(null)` and
 * navigated to `/`, landing the user back on the sign-in screen with no
 * indication that anything had gone wrong. A user who cancelled saw the
 * same blank screen as a user hitting a genuine misconfiguration, and
 * neither had any way to tell which had happened.
 */
export type AuthFailure = 'denied' | 'failed'

export interface AuthContextValue {
  status: AuthStatus
  currentUser: CurrentUser | null
  /** Set by `handleCallback` when a sign-in attempt ends badly; cleared the moment a new one starts. */
  authError: AuthFailure | null
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
  const appConfig = useMemo(() => loadConfig(), [])
  const config = useMemo<OidcConfig>(
    () => ({ issuer: appConfig.oidcIssuer, clientId: appConfig.oidcClientId, redirectUri: appConfig.oidcRedirectUri }),
    [appConfig],
  )

  const [status, setStatus] = useState<AuthStatus>('unauthenticated')
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [authError, setAuthError] = useState<AuthFailure | null>(null)
  const tokensRef = useRef<TokenSet | null>(null)

  const applyTokens = useCallback(
    (tokens: TokenSet | null) => {
      tokensRef.current = tokens
      if (!tokens) {
        setCurrentUser(null)
        setStatus('unauthenticated')
        return
      }

      const claims = decodeJwtPayload(tokens.accessToken)
      setCurrentUser(claims ? claimsToUser(claims) : null)
      setStatus('authenticated')
      if (!claims) return

      // Authenticate first, then fill in permissions — deliberately not
      // awaited before `setStatus('authenticated')`. `AuthGate` renders
      // `LoginPage` for any status other than `authenticated`, so blocking
      // here would flash the login screen at a user who just logged in.
      // The cost is that gated content appears one round trip after the
      // shell does; the alternative costs a visibly wrong screen.
      void (async () => {
        const fetched = await fetchPermissions(appConfig.svcAuthzUrl, tokens.accessToken)
        // `null` means the call failed, not that the user holds nothing —
        // keep whatever set we already have (see `fetchPermissions`).
        if (!fetched) return
        // A refresh, a logout or a second login may have landed while this
        // was in flight; `tokensRef` is the authority on which session is
        // current. Without this, a slow response for an abandoned session
        // would repopulate the menu of a user who just signed out.
        if (tokensRef.current !== tokens) return
        setCurrentUser((prev) => (prev ? { ...prev, permissions: fetched } : prev))
      })()
    },
    [appConfig],
  )

  const login = useCallback(() => {
    // See env.ts's `DEV_BYPASS_ENABLED` header for why this must stay a
    // direct top-level-constant check, not a property read off a config
    // object, to actually tree-shake out of a production build.
    setAuthError(null)
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

    // Keycloak signals a refused or abandoned login by redirecting HERE
    // with `?error=...` and no `code` — it is a normal, expected arrival at
    // this route, not an absent one. Reading only `code` treated it as
    // "nothing to exchange" and bounced the user to a silent sign-in
    // screen; `access_denied` in particular is simply someone clicking
    // Cancel, which deserves a sentence rather than a mystery.
    const oauthError = params.get('error')
    if (oauthError) {
      setAuthError(oauthError === 'access_denied' || oauthError === 'login_required' ? 'denied' : 'failed')
      applyTokens(null)
      return
    }

    // A missing/mismatched `state` is the CSRF check doing its job, and is
    // also what a stale or re-opened callback URL looks like. Either way
    // the user needs to start again, and needs to be told so.
    if (!code || !verifier || !returnedState || returnedState !== expectedState) {
      setAuthError('failed')
      applyTokens(null)
      return
    }
    try {
      const tokens = await exchangeCodeForTokens(config, code, verifier)
      setAuthError(null)
      applyTokens(tokens)
    } catch {
      setAuthError('failed')
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
    () => ({ status, currentUser, authError, login, handleCallback, logout, tokenSource }),
    [status, currentUser, authError, login, handleCallback, logout, tokenSource],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

export { AuthContext }
