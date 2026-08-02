import { readFileSync } from 'node:fs'

/**
 * `svc-crypto` is the only component in the entire system that talks to
 * Vault (Task 6 brief). `VaultTransport` is the injected low-level HTTP
 * layer — the exact pattern `@gadong/kernel`'s `CryptoClient` uses for its
 * own `CryptoTransport` — so `VaultClient` is unit-testable against a fake
 * transport, with no live Vault required anywhere in this test suite.
 */
export interface VaultResponse {
  status: number
  body: unknown
}

export interface VaultTransport {
  request(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<VaultResponse>
}

export interface DataKey {
  /** 32-byte plaintext DEK. Never persisted; the caller discards it after sealing/opening one envelope. */
  plaintextDek: Buffer
  /** Opaque bytes as returned by Vault (its `vault:v1:<base64>` ciphertext string, UTF-8 encoded) — this is what goes in the envelope's length-prefixed header. */
  wrappedDek: Buffer
}

export interface VaultClientConfig {
  /** Base URL is carried by the transport, not this config — kept here only for parity with how a real HTTP transport would be constructed by main.ts. */
  addr: string
  roleId: string
  secretId: string
}

/**
 * The subset of Vault operations `crypto.service.ts` needs, expressed as an
 * interface so `crypto.service.test.ts` can inject a fake Vault directly —
 * without also having to fabricate HTTP-shaped fixtures — while
 * `vault.client.test.ts` separately exercises `VaultClient`'s actual
 * request/response parsing against a fake `VaultTransport`.
 */
export interface VaultPort {
  generateDataKey(kekName: string): Promise<DataKey>
  unwrapDataKey(kekName: string, wrappedDek: Buffer): Promise<Buffer>
  hmac(keyName: string, input: Buffer): Promise<Buffer>
  health(): Promise<'up' | 'down'>
}

/**
 * DI token for `VaultPort`. Interfaces have no runtime representation, so
 * Nest cannot resolve a constructor parameter typed `VaultPort` by type
 * alone — `app.module.ts` binds this token to the real `VaultClient` with
 * `{ provide: VAULT_PORT, useFactory: ... }`, and `crypto.service.ts`
 * asks for it with `@Inject(VAULT_PORT)`.
 */
export const VAULT_PORT = Symbol('VAULT_PORT')

/** Reads the AppRole secret_id from the file `VAULT_APPROLE_SECRET_FILE` points at. Never logs its content. */
export function readApproleSecretFromFile(path: string): string {
  return readFileSync(path, 'utf8').trim()
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

interface CachedToken {
  token: string
  expiresAt: number
}

/**
 * Vault error responses vary by call (`{errors: [...]}` is Vault's own
 * convention for most failures, including a sealed vault), but every one of
 * them means "svc-crypto cannot complete this crypto operation right now" —
 * the caller (`crypto.service.ts`) is the layer that turns that into
 * `CRY-503` and fails closed. This class never returns plaintext, a wrapped
 * key, or an HMAC from a non-2xx response; it always throws instead.
 */
export class VaultClient implements VaultPort {
  private cachedToken: CachedToken | undefined

  constructor(
    private readonly transport: VaultTransport,
    private readonly config: VaultClientConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async generateDataKey(kekName: string): Promise<DataKey> {
    const token = await this.ensureToken()
    const res = await this.transport.request(
      'POST',
      `/v1/transit/datakey/plaintext/${kekName}`,
      undefined,
      this.authHeader(token),
    )
    const data = this.dataOf(res, `generateDataKey(${kekName})`)
    const plaintext = data['plaintext']
    const ciphertext = data['ciphertext']
    if (typeof plaintext !== 'string' || typeof ciphertext !== 'string') {
      throw new Error(`VaultClient.generateDataKey: malformed response for ${kekName}`)
    }
    return {
      plaintextDek: Buffer.from(plaintext, 'base64'),
      // Stored verbatim (UTF-8 bytes of Vault's own ciphertext string) so
      // `unwrapDataKey` can hand it straight back to Vault unchanged.
      wrappedDek: Buffer.from(ciphertext, 'utf8'),
    }
  }

  async unwrapDataKey(kekName: string, wrappedDek: Buffer): Promise<Buffer> {
    const token = await this.ensureToken()
    const res = await this.transport.request(
      'POST',
      `/v1/transit/decrypt/${kekName}`,
      { ciphertext: wrappedDek.toString('utf8') },
      this.authHeader(token),
    )
    const data = this.dataOf(res, `unwrapDataKey(${kekName})`)
    const plaintext = data['plaintext']
    if (typeof plaintext !== 'string') {
      throw new Error(`VaultClient.unwrapDataKey: malformed response for ${kekName}`)
    }
    return Buffer.from(plaintext, 'base64')
  }

  async hmac(keyName: string, input: Buffer): Promise<Buffer> {
    const token = await this.ensureToken()
    const res = await this.transport.request(
      'POST',
      `/v1/transit/hmac/${keyName}`,
      { input: input.toString('base64'), algorithm: 'sha2-256' },
      this.authHeader(token),
    )
    const data = this.dataOf(res, `hmac(${keyName})`)
    const hmac = data['hmac']
    if (typeof hmac !== 'string') {
      throw new Error(`VaultClient.hmac: malformed response for ${keyName}`)
    }
    // Vault's transit hmac response is `vault:v1:<base64>`, the same
    // envelope convention it uses for wrapped keys.
    const prefixEnd = hmac.lastIndexOf(':')
    const b64 = prefixEnd === -1 ? hmac : hmac.slice(prefixEnd + 1)
    return Buffer.from(b64, 'base64')
  }

  /**
   * `up` only when Vault answers *and* reports itself unsealed; `down` for
   * everything else, including a sealed Vault — which is a normal
   * post-reboot state (Runbook §2), not a crash, so this never throws.
   * Vault's `sys/health` endpoint requires no auth, so this deliberately
   * does not call `ensureToken()` — a sealed/uninitialised Vault would
   * reject an AppRole login anyway, and health must still report `down`
   * rather than propagate that failure.
   */
  async health(): Promise<'up' | 'down'> {
    try {
      const res = await this.transport.request('GET', '/v1/sys/health')
      if (!isRecord(res.body)) return 'down'
      return res.body['sealed'] === false ? 'up' : 'down'
    } catch {
      return 'down'
    }
  }

  private authHeader(token: string): Record<string, string> {
    return { 'X-Vault-Token': token }
  }

  private dataOf(res: VaultResponse, context: string): Record<string, unknown> {
    if (res.status < 200 || res.status >= 300 || !isRecord(res.body) || !isRecord(res.body['data'])) {
      throw new Error(`VaultClient.${context}: Vault responded with status ${res.status}`)
    }
    return res.body['data']
  }

  /**
   * Logs in via AppRole on first use and caches the token until shortly
   * before its lease expires (a 30s safety margin so a call started just
   * before expiry doesn't race a since-expired token). Role id and secret
   * id are read once from `this.config` — the secret's content is never
   * logged, here or anywhere else in this class.
   */
  private async ensureToken(): Promise<string> {
    const cached = this.cachedToken
    if (cached && cached.expiresAt > this.now()) return cached.token

    const res = await this.transport.request('POST', '/v1/auth/approle/login', {
      role_id: this.config.roleId,
      secret_id: this.config.secretId,
    })
    if (res.status < 200 || res.status >= 300 || !isRecord(res.body) || !isRecord(res.body['auth'])) {
      throw new Error('VaultClient: AppRole login failed')
    }
    const auth = res.body['auth']
    const token = auth['client_token']
    const leaseSeconds = auth['lease_duration']
    if (typeof token !== 'string' || typeof leaseSeconds !== 'number') {
      throw new Error('VaultClient: AppRole login returned a malformed response')
    }
    const SAFETY_MARGIN_MS = 30_000
    this.cachedToken = { token, expiresAt: this.now() + leaseSeconds * 1000 - SAFETY_MARGIN_MS }
    return token
  }
}

/**
 * The real `VaultTransport`, wired up in `app.module.ts`. Node 22 ships a
 * stable global `fetch`, so no HTTP client dependency is needed. Never
 * logs the request or response body — those can carry a wrapped DEK, an
 * HMAC, or (on a login) the AppRole secret_id.
 */
export function createHttpVaultTransport(baseUrl: string): VaultTransport {
  return {
    async request(method, path, body, headers) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      const parsedBody: unknown = text.length > 0 ? JSON.parse(text) : {}
      return { status: res.status, body: parsedBody }
    },
  }
}
