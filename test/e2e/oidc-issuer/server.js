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
    exp: now + (ttlSeconds || 3600),
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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/token') {
      const body = await readBody(req);
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
