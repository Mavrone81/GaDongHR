import { createHmac, randomBytes } from 'node:crypto'
import { GadongError } from '@gadong/kernel'
import type { EncryptRequest, FieldClass } from '@gadong/kernel'
import { CryptoService } from './crypto.service'
import type { VaultPort, DataKey } from './vault.client'
import { open, buildAad, parseHeader } from './envelope'

/**
 * An in-memory stand-in for Vault Transit that actually enforces the one
 * property the tests below depend on: a wrappedDek can only be unwrapped
 * under the *same* `kekName` it was generated for — exactly like a real
 * Vault Transit key would reject a ciphertext produced under a different
 * named key. This lets `crypto.service.test.ts` exercise real seal/open
 * round-trips without any HTTP or a live Vault.
 */
class FakeVault implements VaultPort {
  private readonly wrapped = new Map<string, { kekName: string; dek: Buffer }>()
  sealedKeks = new Set<string>()
  unreachable = false

  async generateDataKey(kekName: string): Promise<DataKey> {
    if (this.unreachable) throw new Error('ECONNREFUSED')
    if (this.sealedKeks.has(kekName)) throw new Error('Vault is sealed')
    const dek = randomBytes(32)
    const wrappedDek = Buffer.from(`wrapped:${kekName}:${randomBytes(8).toString('hex')}`, 'utf8')
    // Store a copy: crypto.service.ts legitimately zeroes the `plaintextDek`
    // buffer it's handed once it's done with it (defence-in-depth against
    // the plaintext DEK lingering in memory). A real Vault never aliases
    // its own state with a caller's buffer, so this fake must not either —
    // aliasing here would be a test-double bug, not a production one.
    this.wrapped.set(wrappedDek.toString('utf8'), { kekName, dek: Buffer.from(dek) })
    return { plaintextDek: dek, wrappedDek }
  }

  async unwrapDataKey(kekName: string, wrappedDek: Buffer): Promise<Buffer> {
    if (this.unreachable) throw new Error('ECONNREFUSED')
    if (this.sealedKeks.has(kekName)) throw new Error('Vault is sealed')
    const entry = this.wrapped.get(wrappedDek.toString('utf8'))
    if (!entry || entry.kekName !== kekName) throw new Error(`no such wrapped key under ${kekName}`)
    return entry.dek
  }

  async hmac(keyName: string, input: Buffer): Promise<Buffer> {
    if (this.unreachable) throw new Error('ECONNREFUSED')
    if (this.sealedKeks.has(keyName)) throw new Error('Vault is sealed')
    return createHmac('sha256', keyName).update(input).digest()
  }

  async health(): Promise<'up' | 'down'> {
    return this.unreachable || this.sealedKeks.size > 0 ? 'down' : 'up'
  }
}

const field = (overrides: Partial<EncryptRequest> = {}): EncryptRequest => ({
  entityId: 'emp-1',
  field: 'national_id',
  value: '1101700207364',
  fieldClass: 'S3',
  ...overrides,
})

describe('CryptoService.encryptBatch', () => {
  it('returns base64 envelopes that decrypt back to the original values under the right AAD', async () => {
    const vault = new FakeVault()
    const svc = new CryptoService(vault)

    const out = await svc.encryptBatch([field({ field: 'national_id', value: '1101700207364' })])

    expect(Object.keys(out)).toEqual(['national_id'])
    const envelope = Buffer.from(out['national_id'] as string, 'base64')
    // Recover the dek the same way crypto.service must: read the header's
    // fieldClass, unwrap under that one KEK, then open.
    const header = parseHeader(envelope)
    expect(header.fieldClass).toBe('S3')
    const dek = await vault.unwrapDataKey('kek-s3', header.wrappedDek)
    const plaintext = open(dek, buildAad('emp-1', 'national_id'), envelope)
    expect(plaintext.toString('utf8')).toBe('1101700207364')
  })

  it('uses the per-class KEK name (kek-<fieldClass> lowercased)', async () => {
    const vault = new FakeVault()
    const spy = jest.spyOn(vault, 'generateDataKey')
    const svc = new CryptoService(vault)

    await svc.encryptBatch([field({ fieldClass: 'S2' as FieldClass })])

    expect(spy).toHaveBeenCalledWith('kek-s2')
  })

  it('fails closed with CRY-503 and returns nothing when Vault is sealed', async () => {
    const vault = new FakeVault()
    vault.sealedKeks.add('kek-s3')
    const svc = new CryptoService(vault)
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

    await expect(svc.encryptBatch([field()])).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
    // No plaintext anywhere: nothing was logged at all during the failed call.
    expect(logSpy).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('fails closed with CRY-503 when Vault is unreachable', async () => {
    const vault = new FakeVault()
    vault.unreachable = true
    const svc = new CryptoService(vault)

    await expect(svc.encryptBatch([field()])).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
  })

  it('fails the whole batch — no partial response — when one field of several fails', async () => {
    const vault = new FakeVault()
    const realGenerateDataKey = vault.generateDataKey.bind(vault)
    let call = 0
    jest.spyOn(vault, 'generateDataKey').mockImplementation(async (kekName: string) => {
      call += 1
      if (call === 2) throw new Error('simulated Vault failure on the second field')
      return realGenerateDataKey(kekName)
    })
    const svc = new CryptoService(vault)

    await expect(
      svc.encryptBatch([field({ field: 'a' }), field({ field: 'b' }), field({ field: 'c' })]),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })

  it('returns an empty object without calling Vault for an empty batch', async () => {
    const vault = new FakeVault()
    const spy = jest.spyOn(vault, 'generateDataKey')
    const svc = new CryptoService(vault)

    await expect(svc.encryptBatch([])).resolves.toEqual({})
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('CryptoService.decrypt', () => {
  it('round-trips a value sealed by encryptBatch', async () => {
    const vault = new FakeVault()
    const svc = new CryptoService(vault)
    const encrypted = await svc.encryptBatch([field({ entityId: 'emp-1', field: 'national_id', value: '1101700207364' })])

    const value = await svc.decrypt('emp-1', 'national_id', encrypted['national_id'] as string, 'payroll_sso_filing')
    expect(value).toBe('1101700207364')
  })

  it('rejects a blank purpose before making any Vault call', async () => {
    const vault = new FakeVault()
    const spy = jest.spyOn(vault, 'unwrapDataKey')
    const svc = new CryptoService(vault)

    await expect(svc.decrypt('emp-1', 'national_id', Buffer.alloc(64).toString('base64'), '')).rejects.toThrow()
    await expect(svc.decrypt('emp-1', 'national_id', Buffer.alloc(64).toString('base64'), '   ')).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('fails closed with CRY-503 when Vault is sealed, with no plaintext logged', async () => {
    const vault = new FakeVault()
    const svc = new CryptoService(vault)
    const encrypted = await svc.encryptBatch([field({ entityId: 'emp-1', field: 'national_id', value: '1101700207364' })])
    // Only kek-s3 needs to be sealed: decrypt reads fieldClass from the
    // envelope header and unwraps under exactly that one KEK (Task 6 fix
    // round 1) — it no longer needs to guess by trying every class.
    vault.sealedKeks.add('kek-s3')
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      svc.decrypt('emp-1', 'national_id', encrypted['national_id'] as string, 'payroll_sso_filing'),
    ).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
    expect(logSpy).not.toHaveBeenCalled()
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('fails closed with CRY-503 when Vault is unreachable', async () => {
    const vault = new FakeVault()
    const svc = new CryptoService(vault)
    const encrypted = await svc.encryptBatch([field({ entityId: 'emp-1', field: 'national_id', value: '1101700207364' })])
    vault.unreachable = true
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      svc.decrypt('emp-1', 'national_id', encrypted['national_id'] as string, 'payroll_sso_filing'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
    errorSpy.mockRestore()
  })

  it('throws (does not return garbage) when the AAD entityId does not match the one used to seal', async () => {
    const vault = new FakeVault()
    const svc = new CryptoService(vault)
    const encrypted = await svc.encryptBatch([field({ entityId: 'emp-A', field: 'national_id', value: '1101700207364' })])

    await expect(
      svc.decrypt('emp-B', 'national_id', encrypted['national_id'] as string, 'payroll_sso_filing'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })
})

/**
 * Task 6 fix round 1: `decrypt` reads `fieldClass` from the envelope
 * header and unwraps under exactly one KEK — it must never fall back to
 * trying the other class. The "never called" assertions here are the
 * guard; see the report's "guard demonstration" for proof they fail when
 * a fallback is reintroduced.
 */
describe('CryptoService.decrypt — exactly one KEK, chosen from the envelope header', () => {
  it('unwraps an S3-sealed envelope under kek-s3 only; kek-s2 is never called', async () => {
    const vault = new FakeVault()
    const unwrapSpy = jest.spyOn(vault, 'unwrapDataKey')
    const svc = new CryptoService(vault)
    const encrypted = await svc.encryptBatch([
      field({ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }),
    ])

    const value = await svc.decrypt('emp-1', 'national_id', encrypted['national_id'] as string, 'payroll_sso_filing')

    expect(value).toBe('1101700207364')
    expect(unwrapSpy).toHaveBeenCalledTimes(1)
    expect(unwrapSpy).toHaveBeenCalledWith('kek-s3', expect.any(Buffer))
    expect(unwrapSpy).not.toHaveBeenCalledWith('kek-s2', expect.anything())
  })

  it('unwraps an S2-sealed envelope under kek-s2 only; kek-s3 is never called', async () => {
    const vault = new FakeVault()
    const unwrapSpy = jest.spyOn(vault, 'unwrapDataKey')
    const svc = new CryptoService(vault)
    const encrypted = await svc.encryptBatch([
      field({ entityId: 'emp-1', field: 'email', value: 'somchai@example.com', fieldClass: 'S2' }),
    ])

    const value = await svc.decrypt('emp-1', 'email', encrypted['email'] as string, 'consent_lookup')

    expect(value).toBe('somchai@example.com')
    expect(unwrapSpy).toHaveBeenCalledTimes(1)
    expect(unwrapSpy).toHaveBeenCalledWith('kek-s2', expect.any(Buffer))
    expect(unwrapSpy).not.toHaveBeenCalledWith('kek-s3', expect.anything())
  })

  it('a header declaring an unrecognised fieldClass byte fails closed with CRY-503 and never calls Vault', async () => {
    const vault = new FakeVault()
    const unwrapSpy = jest.spyOn(vault, 'unwrapDataKey')
    const svc = new CryptoService(vault)
    const encrypted = await svc.encryptBatch([
      field({ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }),
    ])
    const tampered = Buffer.from(encrypted['national_id'] as string, 'base64')
    tampered.writeUInt8(9, 1) // no fieldClass code 9 exists (S2=2, S3=3)
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      svc.decrypt('emp-1', 'national_id', tampered.toString('base64'), 'payroll_sso_filing'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
    expect(unwrapSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('a header declaring an unrecognised version fails closed with CRY-503 and never calls Vault', async () => {
    const vault = new FakeVault()
    const unwrapSpy = jest.spyOn(vault, 'unwrapDataKey')
    const svc = new CryptoService(vault)
    const encrypted = await svc.encryptBatch([
      field({ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }),
    ])
    const tampered = Buffer.from(encrypted['national_id'] as string, 'base64')
    tampered.writeUInt8(2, 0) // no version 2 exists
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      svc.decrypt('emp-1', 'national_id', tampered.toString('base64'), 'payroll_sso_filing'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
    expect(unwrapSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('Vault sealed during unwrap fails closed after exactly one unwrap attempt — no retry under the other class', async () => {
    const vault = new FakeVault()
    const svc = new CryptoService(vault)
    const encrypted = await svc.encryptBatch([
      field({ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }),
    ])
    vault.sealedKeks.add('kek-s3')
    const unwrapSpy = jest.spyOn(vault, 'unwrapDataKey')
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      svc.decrypt('emp-1', 'national_id', encrypted['national_id'] as string, 'payroll_sso_filing'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
    expect(unwrapSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})

describe('CryptoService.bidx', () => {
  it('returns exactly 32 bytes, deterministic for the same input', async () => {
    const vault = new FakeVault()
    const svc = new CryptoService(vault)

    const a = await svc.bidx('S3', 'national_id', '1101700207364')
    const b = await svc.bidx('S3', 'national_id', '1101700207364')

    expect(Buffer.from(a, 'base64').length).toBe(32)
    expect(a).toBe(b)
  })

  it('is different for different input', async () => {
    const vault = new FakeVault()
    const svc = new CryptoService(vault)

    const a = await svc.bidx('S3', 'national_id', '1101700207364')
    const b = await svc.bidx('S3', 'national_id', '1101700207999')

    expect(a).not.toBe(b)
  })

  it('uses a per-fieldClass key, so the same value differs across classes', async () => {
    const vault = new FakeVault()
    const svc = new CryptoService(vault)

    const s2 = await svc.bidx('S2', 'email', 'somchai@example.com')
    const s3 = await svc.bidx('S3', 'email', 'somchai@example.com')

    expect(s2).not.toBe(s3)
  })

  it('fails closed with CRY-503 when Vault is unreachable', async () => {
    const vault = new FakeVault()
    vault.unreachable = true
    const svc = new CryptoService(vault)

    await expect(svc.bidx('S3', 'email', 'x')).rejects.toMatchObject({ code: 'CRY-503' })
  })
})

describe('CryptoService.health', () => {
  it('reports "up" when Vault is reachable and unsealed', async () => {
    const svc = new CryptoService(new FakeVault())
    await expect(svc.health()).resolves.toBe('up')
  })

  it('reports "down" — not a throw — when Vault is sealed', async () => {
    const vault = new FakeVault()
    vault.sealedKeks.add('kek-s3')
    const svc = new CryptoService(vault)
    await expect(svc.health()).resolves.toBe('down')
  })
})

it('GadongError is re-exported correctly from @gadong/kernel for CRY-503 matching', () => {
  expect(new GadongError('CRY-503', 'crypto.error.unavailable', 503).code).toBe('CRY-503')
})
