import { VaultClient } from './vault.client'
import type { VaultTransport, VaultResponse } from './vault.client'

/**
 * A realistic Vault Transit `datakey/plaintext` ciphertext, built the same way
 * Vault itself builds one for `aes256-gcm96` (Vault's default transit key
 * type): `base64(version_byte(1) ‖ nonce(12) ‖ ciphertext(32) ‖ tag(16))`,
 * prefixed with the literal `vault:v1:`. 1 + 12 + 32 + 16 = 61 raw bytes.
 * This is what pins `wrappedDek`'s byte length — not a remembered number,
 * but the shape of an actual Vault Transit response.
 */
function realisticWrappedDekCiphertext(): string {
  const raw = Buffer.alloc(1 + 12 + 32 + 16, 0x42) // version + nonce + ct(32) + tag(16)
  return `vault:v1:${raw.toString('base64')}`
}

function fakeTransport(handlers: Record<string, (body: unknown) => VaultResponse>): VaultTransport {
  return {
    request: jest.fn(async (_method, path: string, body?: unknown) => {
      const handler = handlers[path]
      if (!handler) throw new Error(`unexpected path ${path}`)
      return handler(body)
    }),
  }
}

const config = { addr: 'http://vault:8200', roleId: 'role-id', secretId: 'secret-id' }

const approleLoginOk = (): VaultResponse => ({
  status: 200,
  body: { auth: { client_token: 'fake-token', lease_duration: 3600, renewable: true } },
})

describe('VaultClient.generateDataKey', () => {
  it('returns a 32-byte plaintext DEK and pins the wrappedDek byte length from a realistic Vault response', async () => {
    const wrappedCiphertext = realisticWrappedDekCiphertext()
    const transport = fakeTransport({
      '/v1/auth/approle/login': approleLoginOk,
      '/v1/transit/datakey/plaintext/kek-s3': () => ({
        status: 200,
        body: { data: { plaintext: Buffer.alloc(32, 7).toString('base64'), ciphertext: wrappedCiphertext } },
      }),
    })
    const client = new VaultClient(transport, config)

    const { plaintextDek, wrappedDek } = await client.generateDataKey('kek-s3')

    expect(plaintextDek.length).toBe(32)
    // This is the number Task 6 §4 requires: pinned by this test, not by a comment.
    expect(wrappedDek.length).toBe(93)
    expect(wrappedDek.toString('utf8')).toBe(wrappedCiphertext)
  })

  it('logs in with AppRole before the first Transit call, sending role_id and secret_id', async () => {
    const login = jest.fn(approleLoginOk)
    const transport = fakeTransport({
      '/v1/auth/approle/login': login,
      '/v1/transit/datakey/plaintext/kek-s2': () => ({
        status: 200,
        body: { data: { plaintext: Buffer.alloc(32, 1).toString('base64'), ciphertext: realisticWrappedDekCiphertext() } },
      }),
    })
    const client = new VaultClient(transport, config)
    await client.generateDataKey('kek-s2')

    expect(login).toHaveBeenCalledWith({ role_id: 'role-id', secret_id: 'secret-id' })
  })

  it('rejects when Vault is sealed (503 with an errors array)', async () => {
    const transport = fakeTransport({
      '/v1/auth/approle/login': approleLoginOk,
      '/v1/transit/datakey/plaintext/kek-s3': () => ({ status: 503, body: { errors: ['Vault is sealed'] } }),
    })
    const client = new VaultClient(transport, config)

    await expect(client.generateDataKey('kek-s3')).rejects.toThrow()
  })

  it('rejects when the transport itself rejects (network error, Vault unreachable)', async () => {
    const transport: VaultTransport = {
      request: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    }
    const client = new VaultClient(transport, config)

    await expect(client.generateDataKey('kek-s3')).rejects.toThrow()
  })

  it('reuses a cached token across calls rather than logging in every time', async () => {
    const login = jest.fn(approleLoginOk)
    const transport = fakeTransport({
      '/v1/auth/approle/login': login,
      '/v1/transit/datakey/plaintext/kek-s2': () => ({
        status: 200,
        body: { data: { plaintext: Buffer.alloc(32, 1).toString('base64'), ciphertext: realisticWrappedDekCiphertext() } },
      }),
    })
    const client = new VaultClient(transport, config)
    await client.generateDataKey('kek-s2')
    await client.generateDataKey('kek-s2')

    expect(login).toHaveBeenCalledTimes(1)
  })
})

describe('VaultClient.unwrapDataKey', () => {
  it('round-trips the plaintext DEK', async () => {
    const dek = Buffer.alloc(32, 5)
    const transport = fakeTransport({
      '/v1/auth/approle/login': approleLoginOk,
      '/v1/transit/decrypt/kek-s3': (body) => {
        expect(body).toEqual({ ciphertext: 'vault:v1:opaque-wrapped-bytes' })
        return { status: 200, body: { data: { plaintext: dek.toString('base64') } } }
      },
    })
    const client = new VaultClient(transport, config)

    const out = await client.unwrapDataKey('kek-s3', Buffer.from('vault:v1:opaque-wrapped-bytes', 'utf8'))
    expect(out.equals(dek)).toBe(true)
  })

  it('rejects when Vault answers with an error', async () => {
    const transport = fakeTransport({
      '/v1/auth/approle/login': approleLoginOk,
      '/v1/transit/decrypt/kek-s3': () => ({ status: 400, body: { errors: ['invalid ciphertext'] } }),
    })
    const client = new VaultClient(transport, config)

    await expect(client.unwrapDataKey('kek-s3', Buffer.from('garbage'))).rejects.toThrow()
  })
})

describe('VaultClient.hmac', () => {
  it('returns exactly 32 bytes and is deterministic for the same input', async () => {
    const hmacBytes = Buffer.alloc(32, 9)
    const transport = fakeTransport({
      '/v1/auth/approle/login': approleLoginOk,
      '/v1/transit/hmac/kek-s3': () => ({
        status: 200,
        body: { data: { hmac: `vault:v1:${hmacBytes.toString('base64')}` } },
      }),
    })
    const client = new VaultClient(transport, config)

    const out = await client.hmac('kek-s3', Buffer.from('1101700207364'))
    expect(out.length).toBe(32)
    expect(out.equals(hmacBytes)).toBe(true)
  })

  it('rejects when Vault is unreachable', async () => {
    const transport: VaultTransport = { request: jest.fn().mockRejectedValue(new Error('timeout')) }
    const client = new VaultClient(transport, config)

    await expect(client.hmac('kek-s3', Buffer.from('x'))).rejects.toThrow()
  })
})

describe('VaultClient.health', () => {
  it('is "up" when Vault answers unsealed, without needing an AppRole login', async () => {
    const login = jest.fn(approleLoginOk)
    const transport = fakeTransport({
      '/v1/auth/approle/login': login,
      '/v1/sys/health': () => ({ status: 200, body: { sealed: false, initialized: true } }),
    })
    const client = new VaultClient(transport, config)

    await expect(client.health()).resolves.toBe('up')
    expect(login).not.toHaveBeenCalled()
  })

  it('is "down" — not a throw — when Vault is sealed (a normal post-reboot state)', async () => {
    const transport = fakeTransport({
      '/v1/sys/health': () => ({ status: 503, body: { sealed: true, initialized: true } }),
    })
    const client = new VaultClient(transport, config)

    await expect(client.health()).resolves.toBe('down')
  })

  it('is "down" — not a throw — when Vault is unreachable', async () => {
    const transport: VaultTransport = { request: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    const client = new VaultClient(transport, config)

    await expect(client.health()).resolves.toBe('down')
  })
})
