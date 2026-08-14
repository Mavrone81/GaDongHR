import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(async (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 256)),
  digestStringAsync: jest.fn(async () => 'ZGlnZXN0'),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
}));

const mockOpenAuthSessionAsync = jest.fn();
jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: (...args: unknown[]) => mockOpenAuthSessionAsync(...args),
}));

jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'gadonghr://auth/callback',
}));

jest.mock('../api/env', () => ({
  loadConfig: () => ({ oidcIssuer: 'http://127.0.0.1:18081', oidcClientId: 'mobile', oidcAudience: 'gadonghr-services' }),
}));

import { AuthProvider, useAuth, parseRedirectParams } from './AuthContext';

describe('parseRedirectParams', () => {
  it('extracts code/state from an https redirect', () => {
    const params = parseRedirectParams('https://app.example/callback?code=abc&state=xyz');
    expect(params.get('code')).toBe('abc');
    expect(params.get('state')).toBe('xyz');
  });

  it('extracts code/state from a custom-scheme redirect (exp://, gadonghr://)', () => {
    expect(parseRedirectParams('exp://127.0.0.1:19000/--/auth/callback?code=c1&state=s1').get('code')).toBe('c1');
    expect(parseRedirectParams('gadonghr://auth/callback?code=c2&state=s2').get('state')).toBe('s2');
  });

  it('returns empty params when there is no query string', () => {
    expect(parseRedirectParams('gadonghr://auth/callback').toString()).toBe('');
  });

  it('ignores a fragment after the query string', () => {
    expect(parseRedirectParams('https://x/y?code=c#frag=1').get('code')).toBe('c');
  });
});

function Probe(): React.JSX.Element {
  const { status, currentUser, login } = useAuth();
  return (
    <>
      <Text testID="status">{status}</Text>
      <Text testID="user">{currentUser?.username ?? ''}</Text>
      <Text testID="login" onPress={() => void login()}>
        login
      </Text>
    </>
  );
}

describe('AuthProvider / login flow', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('completes login: opens the auth session, exchanges the code, lands authenticated', async () => {
    mockOpenAuthSessionAsync.mockImplementation(async (authorizeUrl: string) => {
      const state = new URL(authorizeUrl).searchParams.get('state');
      return { type: 'success', url: `gadonghr://auth/callback?code=real-code&state=${state ?? ''}` };
    });

    const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const fakeAccessToken = `${encode({ alg: 'none' })}.${encode({ sub: 'u1', preferred_username: 'somchai' })}.`;
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ access_token: fakeAccessToken, expires_in: 300, token_type: 'Bearer' }), { status: 200 })) as typeof fetch;

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByTestId('status').props.children).toBe('unauthenticated');
    fireEvent.press(screen.getByTestId('login'));

    await waitFor(() => expect(screen.getByTestId('status').props.children).toBe('authenticated'));
    expect(screen.getByTestId('user').props.children).toBe('somchai');
    expect(mockOpenAuthSessionAsync).toHaveBeenCalledTimes(1);
  });

  it('stays unauthenticated when the browser session is cancelled', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'cancel' });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    fireEvent.press(screen.getByTestId('login'));

    await waitFor(() => expect(screen.getByTestId('status').props.children).toBe('unauthenticated'));
  });

  it('stays unauthenticated when the returned state does not match (anti-CSRF)', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'gadonghr://auth/callback?code=c&state=WRONG' });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    fireEvent.press(screen.getByTestId('login'));

    await waitFor(() => expect(screen.getByTestId('status').props.children).toBe('unauthenticated'));
  });
});
