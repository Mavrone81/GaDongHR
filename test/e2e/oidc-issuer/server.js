// Minimal OIDC-shaped issuer for the e2e stack — stands in for Keycloak,
// which the harness does not run (see test/e2e/README.md).
//
// This is NOT an application mock: it is real infrastructure, standing
// exactly where an external identity provider sits. Every service under
// test still does a real HTTPS-shaped JWKS fetch and a real RS256
// signature verification via `jose.jwtVerify` in
// packages/kernel/src/authz/oidc.middleware.ts — nothing in that
// verification path is bypassed or faked. Only the *issuer* is a stub, the
// same way a test suite stands up a fake SMTP server instead of relying on
// real Gmail.
//
// Zero npm dependencies on purpose (fast image build): RS256 signing uses
// Node's built-in `crypto` module directly.
'use strict';
const crypto = require('crypto');
const http = require('http');

const ISSUER = process.env.OIDC_ISSUER || 'https://e2e.gadonghr.internal/realms/gadonghr';
const AUDIENCE = process.env.OIDC_AUDIENCE || 'gadonghr-services';
const KID = 'e2e-issuer-key-1';

// S2S auth task: the machine-principal client registry this stand-in
// authenticates against real OAuth2 client_credentials requests (RFC 6749
// §4.4) — the SAME wire format `packages/kernel/src/authz/
// machine-token.client.ts`'s `createHttpTokenTransport` sends against real
// Keycloak, so a calling service's code path never branches on which
// environment it is talking to; only `OIDC_TOKEN_URL`/the client secret
// differ (config, not code — see that file's header). `harness.ts` sets
// `OIDC_CLIENTS` to the exact same JSON this file parses, so the two never
// drift silently the way two independently-typed literals could.
const CLIENTS = JSON.parse(process.env.OIDC_CLIENTS || '{}');
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(sub, extraClaims, ttlSeconds) {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub,
    iat: now,
    exp: now + (ttlSeconds || DEFAULT_TOKEN_TTL_SECONDS),
    ...extraClaims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * A client_credentials token's `sub` is the SAME kind of value a human
 * token's `sub` is (`azp`/`clientId` added alongside it, matching what
 * Keycloak itself stamps — see `machine-token.client.ts`'s file header) —
 * `OidcMiddleware` needs no special-casing to accept it. Unknown
 * client_id/wrong secret both produce a generic `invalid_client` (never
 * revealing WHICH check failed), matching OAuth2's own error-shape
 * convention (RFC 6749 §5.2) and this codebase's house rule of never
 * echoing back which part of a credential check failed.
 */
function issueClientCredentialsToken(clientId, clientSecret) {
  const client = CLIENTS[clientId];
  if (!client || client.secret !== clientSecret) return null;
  return sign(client.sub, { azp: clientId, client_id: clientId }, DEFAULT_TOKEN_TTL_SECONDS);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/token') {
      const contentType = String(req.headers['content-type'] || '');
      const body = await readBody(req);

      // Real OAuth2 client_credentials (RFC 6749 §4.4.2), form-encoded —
      // the wire format `MachineTokenClient`'s real HTTP transport sends,
      // identical to what real Keycloak expects. This is the S2S auth
      // path every service under test actually exercises.
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(body);
        if (params.get('grant_type') !== 'client_credentials') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
          return;
        }
        const token = issueClientCredentialsToken(params.get('client_id') || '', params.get('client_secret') || '');
        if (!token) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_client' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: DEFAULT_TOKEN_TTL_SECONDS }));
        return;
      }

      // Test-harness-only back door: mint an arbitrary human/persona token
      // by `sub` directly (`harness.ts`'s `mintToken`) — this is the JSON-
      // body shape this endpoint has always accepted, for the SAME reason
      // `deploy/scripts/bootstrap-admin.sh` uses Keycloak's own Admin API
      // (a totally different mechanism from client_credentials) to create
      // a human user: minting an arbitrary test persona has no real-world
      // analogue for this stand-in to reuse the client_credentials path
      // for. Never used by any application code path under test.
      const parsed = body ? JSON.parse(body) : {};
      if (!parsed.sub || typeof parsed.sub !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'sub is required' }));
        return;
      }
      const token = sign(parsed.sub, parsed.claims || {}, parsed.ttlSeconds);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, issuer: ISSUER, audience: AUDIENCE }));
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String((err && err.message) || err) }));
  }
});

server.listen(8080, '0.0.0.0', () => {
  console.log(`e2e oidc-issuer listening on :8080, issuer=${ISSUER} audience=${AUDIENCE}`);
});
