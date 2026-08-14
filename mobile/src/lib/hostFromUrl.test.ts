import { hostFromUrl } from './hostFromUrl';

describe('hostFromUrl', () => {
  it('extracts host:port from an http(s) URL', () => {
    expect(hostFromUrl('http://127.0.0.1:18081/realms/gadonghr')).toBe('127.0.0.1:18081');
    expect(hostFromUrl('https://hr.bevorasg.com/auth/realms/gadonghr')).toBe('hr.bevorasg.com');
  });

  it('falls back to the raw input when no scheme is present', () => {
    expect(hostFromUrl('not-a-url')).toBe('not-a-url');
  });
});
