import { loadConfig, resolveServiceUrl } from './env';

describe('env', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws naming the missing var when EXPO_PUBLIC_OIDC_ISSUER is unset', () => {
    delete process.env['EXPO_PUBLIC_OIDC_ISSUER'];
    expect(() => loadConfig()).toThrow(/EXPO_PUBLIC_OIDC_ISSUER/);
  });

  it('defaults apiBaseUrl to same-origin /api', () => {
    process.env['EXPO_PUBLIC_OIDC_ISSUER'] = 'http://issuer';
    delete process.env['EXPO_PUBLIC_API_BASE_URL'];
    expect(loadConfig().apiBaseUrl).toBe('/api');
  });

  it('resolveServiceUrl composes apiBaseUrl + service path when no override is set', () => {
    process.env['EXPO_PUBLIC_OIDC_ISSUER'] = 'http://issuer';
    delete process.env['EXPO_PUBLIC_SVC_ATTENDANCE_URL'];
    const config = loadConfig();
    expect(resolveServiceUrl(config, 'attendance')).toBe('/api/attendance');
  });

  it('resolveServiceUrl prefers a per-service absolute override (local e2e dev)', () => {
    process.env['EXPO_PUBLIC_OIDC_ISSUER'] = 'http://issuer';
    process.env['EXPO_PUBLIC_SVC_ATTENDANCE_URL'] = 'http://127.0.0.1:18006';
    const config = loadConfig();
    expect(resolveServiceUrl(config, 'attendance')).toBe('http://127.0.0.1:18006');
    expect(resolveServiceUrl(config, 'timesheet')).toBe('/api/timesheet');
  });
});
