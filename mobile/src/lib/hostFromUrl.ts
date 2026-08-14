/** Extracts a displayable host from a full URL — used by `LoginScreen`'s footer, mirroring web's `window.location.hostname` ("which deployment is this") with the mobile equivalent: the OIDC issuer's own host, since there is no browser location to read. */
export function hostFromUrl(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(url);
  return match?.[1] ?? url;
}
