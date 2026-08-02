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
    const transport = okTransport({
      '/encrypt': { fields: { national_id: Buffer.from('ct1').toString('base64') } },
    })
    const c = new CryptoClient(transport)
    const out = await c.encryptBatch([
      { entityId: 'emp-1', field: 'national_id', value: '1101700207364', fieldClass: 'S3' },
    ])
    expect(out.get('national_id')).toEqual(Buffer.from('ct1'))
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
    const transport = okTransport({ '/encrypt': { fields: { a: Buffer.from('x').toString('base64') } } })
    const c = new CryptoClient(transport)
    await expect(
      c.encryptBatch([
        { entityId: 'e', field: 'a', value: '1', fieldClass: 'S2' },
        { entityId: 'e', field: 'b', value: '2', fieldClass: 'S2' },
      ]),
    ).rejects.toBeInstanceOf(GadongError)
  })
})

describe('CryptoClient.decrypt', () => {
  it('requires a non-empty purpose — the audit entry depends on it', async () => {
    const c = new CryptoClient(okTransport({}))
    await expect(c.decrypt('emp-1', 'national_id', Buffer.from('ct'), '')).rejects.toThrow(/purpose/i)
  })

  it('passes entityId and field so AAD is reconstructed on the service side', async () => {
    const transport = okTransport({ '/decrypt': { value: '1101700207364' } })
    const c = new CryptoClient(transport)
    const v = await c.decrypt('emp-1', 'national_id', Buffer.from('ct'), 'payroll_sso_filing')
    expect(v).toBe('1101700207364')
    expect(transport.post).toHaveBeenCalledWith('/decrypt', {
      entityId: 'emp-1',
      field: 'national_id',
      ciphertext: Buffer.from('ct').toString('base64'),
      purpose: 'payroll_sso_filing',
    })
  })

  it('fails closed on transport error', async () => {
    const transport: CryptoTransport = { post: jest.fn().mockRejectedValue(new Error('sealed')) }
    await expect(
      new CryptoClient(transport).decrypt('e', 'f', Buffer.from('c'), 'p'),
    ).rejects.toMatchObject({ code: 'CRY-503' })
  })
})

describe('CryptoClient.blindIndex', () => {
  it('normalises before hashing so lookups match on case and spacing', async () => {
    const transport = okTransport({ '/bidx': { bidx: Buffer.from('h').toString('base64') } })
    const c = new CryptoClient(transport)
    await c.blindIndex('S3', 'email', '  Somchai@Example.COM ')
    expect(transport.post).toHaveBeenCalledWith('/bidx', {
      fieldClass: 'S3', field: 'email', value: 'somchai@example.com',
    })
  })
})
