import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { loadConfig } from '../api/env';
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshTokenSet } from './oidcClient';
import type { OidcConfig, TokenSet } from './oidcClient';
import { randomString, codeChallengeFromVerifier } from './pkce';
import { decodeJwtPayload } from './jwt';
import type { JwtClaims } from './jwt';
import type { AuthTokenSource } from '../api/httpClient';

// Recommended by Expo's AuthSession docs: dismisses the in-app browser
// automatically once it redirects back into the app (native only — a
// harmless no-op on web). Registered once, at module scope.
WebBrowser.maybeCompleteAuthSession();

/**
 * SECURITY: tokens live ONLY in React state (in-memory, this module),
 * never in `AsyncStorage`/`SecureStore` — the exact same rule and
 * rationale as `web/src/auth/AuthContext.tsx`'s header (this app renders
 * salaries and national-ID-adjacent statutory data; a compromised device
 * keychain or a debug bridge able to read `AsyncStorage` would exfiltrate
 * a session capable of reading them). The cost is the same too: an app
 * relaunch (not just a screen reload — the JS runtime restarting) drops
 * the session and forces a fresh login, no silent re-hydration.
 *
 * FLOW SHAPE VS. WEB: web's login is a two-navigation flow — redirect the
 * whole tab to Keycloak, land back on a separate `/auth/callback` route
 * (`CallbackPage.tsx`) after the browser reloads the page. Native has no
 * equivalent page reload: `WebBrowser.openAuthSessionAsync` opens an
 * in-app browser (ASWebAuthenticationSession / Custom Tabs) and its
 * returned promise resolves with the redirect URL once Keycloak sends the
 * user back — the app process, and this closure's local `verifier`/
 * `state`, are never torn down in between. So `login()` here does the
 * whole authorize -> redirect -> code -> token-exchange round trip in one
 * function; there is no separate `handleCallback()`/callback screen.
 */
export type AuthStatus = 'unauthenticated' | 'authenticating' | 'authenticated';

export interface CurrentUser {
  id: string;
  username: string;
  /** UI-ONLY convenience set — see `web/src/auth/AuthContext.tsx`'s `CurrentUser` doc for why this is never a security boundary. Every write this app makes is still enforced for real by the resource server's own `PermissionGuard`. */
  permissions: Set<string>;
}

export interface AuthContextValue {
  status: AuthStatus;
  currentUser: CurrentUser | null;
  /** Opens Keycloak's hosted login page in an in-app browser and completes the PKCE exchange. Resolves once sign-in finishes (or the user cancels/it fails) — check `status` afterward. */
  login: () => Promise<void>;
  logout: () => void;
  tokenSource: AuthTokenSource;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Extracts the query string from a redirect URL of any scheme (`https://`, `exp://`, `gadonghr://`) without relying on RN's incomplete `URL` polyfill. Exported for `AuthContext.test.tsx`. */
export function parseRedirectParams(url: string): URLSearchParams {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return new URLSearchParams();
  const fragmentStart = url.indexOf('#', queryStart);
  const query = fragmentStart === -1 ? url.slice(queryStart + 1) : url.slice(queryStart + 1, fragmentStart);
  return new URLSearchParams(query);
}

function claimsToUser(claims: JwtClaims): CurrentUser {
  const permissions = Array.isArray(claims['permissions']) ? (claims['permissions'] as unknown[]).filter((p): p is string => typeof p === 'string') : [];
  return {
    id: claims.sub ?? '',
    username: claims.preferred_username ?? claims.email ?? claims.sub ?? '',
    permissions: new Set(permissions),
  };
}

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const config = useMemo<OidcConfig>(() => {
    const cfg = loadConfig();
    return {
      issuer: cfg.oidcIssuer,
      clientId: cfg.oidcClientId,
      // Expo's own redirect-URI builder: an `exp://` deep link in Expo Go,
      // the app's registered `scheme` (app.json) in a dev/standalone
      // build. MUST be added to the OIDC client's registered
      // `redirectUris` (Keycloak / the e2e stand-in's `OIDC_CLIENTS`) —
      // see mobile/README's device-test checklist; this exact value can
      // only be known once printed by a running Expo session, the same
      // "value moves, update the registration" caveat web's own
      // `VITE_OIDC_REDIRECT_URI` comment carries for its dev-server port.
      redirectUri: AuthSession.makeRedirectUri({ path: 'auth/callback' }),
    };
  }, []);

  const [status, setStatus] = useState<AuthStatus>('unauthenticated');
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const tokensRef = useRef<TokenSet | null>(null);

  const applyTokens = useCallback((tokens: TokenSet | null) => {
    tokensRef.current = tokens;
    if (tokens) {
      const claims = decodeJwtPayload(tokens.accessToken);
      setCurrentUser(claims ? claimsToUser(claims) : null);
      setStatus('authenticated');
    } else {
      setCurrentUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const login = useCallback(async () => {
    setStatus('authenticating');
    try {
      const verifier = await randomString();
      const state = await randomString(32);
      const challenge = await codeChallengeFromVerifier(verifier);
      const authorizeUrl = buildAuthorizeUrl(config, state, challenge);

      const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, config.redirectUri);
      if (result.type !== 'success' || !result.url) {
        applyTokens(null);
        return;
      }

      // Not `new URL(result.url).searchParams`: RN's `URL` polyfill does
      // not reliably parse the custom-scheme redirect URIs this flow
      // actually produces (`exp://…` in Expo Go, `gadonghr://…` in a
      // dev/standalone build) — a plain query-string extraction is robust
      // to any scheme and is all `parseRedirectParams` below needs.
      const params = parseRedirectParams(result.url);
      const code = params.get('code');
      const returnedState = params.get('state');
      if (!code || !returnedState || returnedState !== state) {
        applyTokens(null);
        return;
      }

      const tokens = await exchangeCodeForTokens(config, code, verifier);
      applyTokens(tokens);
    } catch {
      applyTokens(null);
    }
  }, [config, applyTokens]);

  const logout = useCallback(() => {
    applyTokens(null);
  }, [applyTokens]);

  const refresh = useCallback(async (): Promise<string | null> => {
    const current = tokensRef.current;
    if (!current?.refreshToken) return null;
    const next = await refreshTokenSet(config, current.refreshToken);
    if (!next) return null;
    applyTokens(next);
    return next.accessToken;
  }, [config, applyTokens]);

  const tokenSource = useMemo<AuthTokenSource>(
    () => ({
      getAccessToken: () => tokensRef.current?.accessToken ?? null,
      refresh,
      onUnauthorized: () => applyTokens(null),
    }),
    [refresh, applyTokens],
  );

  const value = useMemo<AuthContextValue>(() => ({ status, currentUser, login, logout, tokenSource }), [status, currentUser, login, logout, tokenSource]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

export { AuthContext };
