import { CryptoClient } from './client'
import type { CryptoTransport } from './client'
import { GadongError } from '../errors'

const okTransport = (responses: Record<string, unknown>): CryptoTransport => ({
  post: jest.fn(async (path: string) => {
    if (!(path in responses)) throw new Error(`unexpected path ${path}`)
    return responses[path]
  }),
})

describe('CryptoClient.normalise', () => {
  const c = new CryptoClient(okTransport({}))
  it('trims, lowercases and NFKC-folds so a blind index matches variants', () => {
    expect(c.normalise('  Somchai@Example.COM ')).toBe('somchai@example.com')
  })
  it('folds full-width characters to their canonical form', () => {
    expect(c.normalise('ＡＢＣ')).toBe('abc')
  })
})

describe('CryptoClient.encryptBatch', () => {
  it('sends entityId and field so the service can bind them as AAD', async () => {
    const ct1 = Buffer.alloc(123, 9) // valid ciphertext-floor-length fixture (u16be prefix + wrappedDEK(93) + nonce + tag)
    const transport = okTransport({
      '/encrypt': { fields: { national_id: ct1.toString('base64') } },
    })
    const c = new CryptoClient(transport)
    const out = await c.encryptBatch([
      { entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' },
    ])
    expect(out.get('national_id')).toEqual(ct1)
    expect(transport.post).toHaveBeenCalledWith('/encrypt', {
      fields: [{ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }],
    })
  })

  it('fails closed with CRY-503 when the crypto service is unreachable', async () => {
    const transport: CryptoTransport = { post: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([{ entityId: 'e', field: 'f', value: 'v', fieldClass: 'S3' }]),
    ).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
  })

  it('never returns a partial result when one field fails', async () => {
    // 'a' is a valid-length ciphertext fixture so the rejection below is specifically
    // because 'b' is missing from the response, not incidentally a short-ciphertext failure.
    const transport = okTransport({ '/encrypt': { fields: { a: Buffer.alloc(123, 1).toString('base64') } } })
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([
        { entityId: 'e', field: 'a', value: '1', fieldClass: 'S2' },
        { entityId: 'e', field: 'b', value: '2', fieldClass: 'S2' },
      ]),
    ).rejects.toBeInstanceOf(GadongError)
  })

  it('returns an empty map without calling the transport for an empty batch', async () => {
    const transport = okTransport({})
    const c = new CryptoClient(transport)
    const out = await c.encryptBatch([])
    expect(out).toEqual(new Map())
    expect(transport.post).not.toHaveBeenCalled()
  })

  it('rejects a duplicate field within one batch rather than silently collapsing it', async () => {
    const transport = okTransport({
      '/encrypt': { fields: { national_id: Buffer.alloc(123, 1).toString('base64') } },
    })
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([
        { entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' },
        { entityId: 'emp-2', field: 'national_id', value: '1101700207999', fieldClass: 'S3' },
      ]),
    ).rejects.toThrow(/duplicate/i)
    expect(transport.post).not.toHaveBeenCalled()
  })

  it('fails closed with CRY-503 when a field decodes to less than the ciphertext floor (122 bytes)', async () => {
    const transport = okTransport({
      '/encrypt': { fields: { national_id: Buffer.alloc(122, 1).toString('base64') } },
    })
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([{ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }]),
    ).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
  })

  it('fails closed with CRY-503 when a field decodes to an empty ciphertext', async () => {
    const transport = okTransport({ '/encrypt': { fields: { national_id: '' } } })
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([{ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }]),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })

  it('fails closed with CRY-503 when a field decodes to what looks like echoed plaintext', async () => {
    // "1101700207364" base64-decodes to 9 bytes — well under the 123-byte ciphertext floor.
    const transport = okTransport({ '/encrypt': { fields: { national_id: '1101700207364' } } })
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([{ entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' }]),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })

  it('fails closed with CRY-503 when the response is not a record with a fields map', async () => {
    const transport = okTransport({ '/encrypt': 'not-a-record' })
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([{ entityId: 'e', field: 'f', value: 'v', fieldClass: 'S2' }]),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })
})

describe('CryptoClient.decrypt', () => {
  it('requires a non-empty purpose — the audit entry depends on it', async () => {
    const c = new CryptoClient(okTransport({}))
    await expect(c.decrypt('emp-1', 'national_id', Buffer.from('ct'), '')).rejects.toThrow(/purpose/i)
  })

  it('rejects a whitespace-only purpose, not just an exactly-empty string', async () => {
    const c = new CryptoClient(okTransport({}))
    await expect(c.decrypt('emp-1', 'national_id', Buffer.from('ct'), '   ')).rejects.toThrow(/purpose/i)
  })

  it('rejects a zero-width-space-only purpose that looks blank but survives trim()', async () => {
    const c = new CryptoClient(okTransport({}))
    await expect(c.decrypt('emp-1', 'national_id', Buffer.from('ct'), '\u200B')).rejects.toThrow(/purpose/i)
  })

  it('transmits the trimmed purpose so the audit entry does not record surrounding whitespace', async () => {
    const ct = Buffer.alloc(123, 2) // valid ciphertext-floor-length fixture
    const transport = okTransport({ '/decrypt': { value: '1101700207364' } })
    const c = new CryptoClient(transport)
    await c.decrypt('emp-1', 'national_id', ct, '  payroll_sso_filing  ')
    expect(transport.post).toHaveBeenCalledWith('/decrypt', {
      entityId: 'emp-1',
      field: 'national_id',
      ciphertext: ct.toString('base64'),
      purpose: 'payroll_sso_filing',
    })
  })

  it('passes entityId and field so AAD is reconstructed on the service side', async () => {
    const ct = Buffer.alloc(123, 2) // valid ciphertext-floor-length fixture
    const transport = okTransport({ '/decrypt': { value: '1101700207364' } })
    const c = new CryptoClient(transport)
    const v = await c.decrypt('emp-1', 'national_id', ct, 'payroll_sso_filing')
    expect(v).toBe('1101700207364')
    expect(transport.post).toHaveBeenCalledWith('/decrypt', {
      entityId: 'emp-1',
      field: 'national_id',
      ciphertext: ct.toString('base64'),
      purpose: 'payroll_sso_filing',
    })
  })

  it('fails closed on transport error', async () => {
    // Valid-length ciphertext argument so this rejection is unambiguously the
    // transport failure, not incidentally the ciphertext-floor check below.
    const transport: CryptoTransport = { post: jest.fn().mockRejectedValue(new Error('sealed')) }
    await expect(
      new CryptoClient(transport).decrypt('e', 'f', Buffer.alloc(123, 3), 'p'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })

  it('fails closed with CRY-503 when the response has no string value', async () => {
    // Valid-length ciphertext argument so this rejection is unambiguously the
    // malformed-response branch, not incidentally the ciphertext-floor check below.
    const transport = okTransport({ '/decrypt': { value: 42 } })
    await expect(
      new CryptoClient(transport).decrypt('e', 'f', Buffer.alloc(123, 3), 'p'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })

  it('fails closed with CRY-503 when the ciphertext argument is empty (0 bytes)', async () => {
    const transport = okTransport({ '/decrypt': { value: 'irrelevant' } })
    await expect(
      new CryptoClient(transport).decrypt('e', 'f', Buffer.alloc(0), 'p'),
    ).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
    expect(transport.post).not.toHaveBeenCalled()
  })

  it('fails closed with CRY-503 when the ciphertext argument is below the 123-byte floor (122 bytes)', async () => {
    const transport = okTransport({ '/decrypt': { value: 'irrelevant' } })
    await expect(
      new CryptoClient(transport).decrypt('e', 'f', Buffer.alloc(122, 1), 'p'),
    ).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
    expect(transport.post).not.toHaveBeenCalled()
  })

  it('accepts a ciphertext argument exactly at the 123-byte floor', async () => {
    const transport = okTransport({ '/decrypt': { value: '1101700207364' } })
    const v = await new CryptoClient(transport).decrypt('e', 'f', Buffer.alloc(123, 1), 'p')
    expect(v).toBe('1101700207364')
    expect(transport.post).toHaveBeenCalledWith('/decrypt', {
      entityId: 'e',
      field: 'f',
      ciphertext: Buffer.alloc(123, 1).toString('base64'),
      purpose: 'p',
    })
  })
})

describe('CryptoClient.blindIndex', () => {
  it('normalises before hashing so lookups match on case and spacing', async () => {
    const bidx = Buffer.alloc(32, 7) // valid HMAC-SHA256-length fixture
    const transport = okTransport({ '/bidx': { bidx: bidx.toString('base64') } })
    const c = new CryptoClient(transport)
    const out = await c.blindIndex('S3', 'email', '  Somchai@Example.COM ')
    expect(out).toEqual(bidx)
    expect(transport.post).toHaveBeenCalledWith('/bidx', {
      fieldClass: 'S3', field: 'email', value: 'somchai@example.com',
    })
  })

  it('fails closed with CRY-503 when the response decodes to less than the 32-byte HMAC-SHA256 length (31 bytes)', async () => {
    const transport = okTransport({ '/bidx': { bidx: Buffer.alloc(31, 1).toString('base64') } })
    const c = new CryptoClient(transport)
    await expect(
      c.blindIndex('S3', 'email', 'somchai@example.com'),
    ).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
  })

  it('fails closed with CRY-503 when the response decodes to more than the 32-byte HMAC-SHA256 length (33 bytes)', async () => {
    // An over-long value can't collide with a real 32-byte bidx, but it is still a
    // knowingly-malformed value that must never be written to a `<field>_bidx` column —
    // the check is an exact-length equality, not a minimum.
    const transport = okTransport({ '/bidx': { bidx: Buffer.alloc(33, 1).toString('base64') } })
    const c = new CryptoClient(transport)
    await expect(
      c.blindIndex('S3', 'email', 'somchai@example.com'),
    ).rejects.toMatchObject({ code: 'CRY-503', httpStatus: 503 })
  })

  it('fails closed with CRY-503 when the response decodes to an empty bidx', async () => {
    const transport = okTransport({ '/bidx': { bidx: '' } })
    const c = new CryptoClient(transport)
    await expect(
      c.blindIndex('S3', 'email', 'somchai@example.com'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })

  it('fails closed with CRY-503 when the crypto service is unreachable', async () => {
    const transport: CryptoTransport = { post: jest.fn().mockRejectedValue(new Error('sealed')) }
    await expect(
      new CryptoClient(transport).blindIndex('S3', 'email', 'somchai@example.com'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })

  it('fails closed with CRY-503 when the response has no string bidx', async () => {
    const transport = okTransport({ '/bidx': { bidx: 12345 } })
    const c = new CryptoClient(transport)
    await expect(
      c.blindIndex('S3', 'email', 'somchai@example.com'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })
})
