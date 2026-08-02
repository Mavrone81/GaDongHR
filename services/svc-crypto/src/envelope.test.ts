import { seal, open, parseHeader, buildAad } from './envelope'

const dek = (fill = 1): Buffer => Buffer.alloc(32, fill)
const wrappedDekFixture = (): Buffer => Buffer.from('vault:v1:fixture-wrapped-dek-opaque-bytes', 'utf8')
const HEADER_BYTES = 4 // version(1) + fieldClass(1) + u16be length(2)

describe('envelope round-trip', () => {
  const cases: [string, string][] = [
    ['empty string', ''],
    ['1 byte', 'a'],
    ['1 MB', 'x'.repeat(1024 * 1024)],
    ['Thai text', 'สวัสดีครับ ยินดีต้อนรับ'],
    ['Simplified Chinese text', '你好，欢迎使用甘东人力资源系统'],
  ]

  it.each(cases)('opens what it sealed: %s', (_label, plaintext) => {
    const d = dek()
    const wrappedDek = wrappedDekFixture()
    const aad = buildAad('emp-A', 'national_id')
    const pt = Buffer.from(plaintext, 'utf8')

    const sealed = seal(d, wrappedDek, 'S3', aad, pt)
    const opened = open(d, aad, sealed)

    expect(opened.equals(pt)).toBe(true)
  })

  it.each((['S2', 'S3'] as const))('round-trips under fieldClass %s and parseHeader recovers it', (fieldClass) => {
    const d = dek()
    const aad = buildAad('emp-A', 'national_id')
    const sealed = seal(d, wrappedDekFixture(), fieldClass, aad, Buffer.from('1101700207364'))

    expect(parseHeader(sealed).fieldClass).toBe(fieldClass)
    expect(open(d, aad, sealed).toString('utf8')).toBe('1101700207364')
  })
})

describe('AAD binding — the headline property', () => {
  it('throws when opened under a different entityId', () => {
    const d = dek()
    const sealed = seal(d, wrappedDekFixture(), 'S3', buildAad('emp-A', 'national_id'), Buffer.from('1101700207364'))

    expect(() => open(d, buildAad('emp-B', 'national_id'), sealed)).toThrow()
  })

  it('throws when opened under a different field, same entityId', () => {
    const d = dek()
    const sealed = seal(d, wrappedDekFixture(), 'S3', buildAad('emp-A', 'national_id'), Buffer.from('1101700207364'))

    expect(() => open(d, buildAad('emp-A', 'bank_account'), sealed)).toThrow()
  })

  it('does not return a partial or garbage value on AAD mismatch — the call throws, nothing is returned', () => {
    const d = dek()
    const sealed = seal(d, wrappedDekFixture(), 'S3', buildAad('emp-A', 'national_id'), Buffer.from('1101700207364'))

    let result: Buffer | undefined
    let threw = false
    try {
      result = open(d, buildAad('emp-B', 'national_id'), sealed)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(result).toBeUndefined()
  })
})

describe('tamper detection', () => {
  it('throws when a bit is flipped in the ciphertext region', () => {
    const d = dek()
    const aad = buildAad('emp-A', 'national_id')
    const sealed = seal(d, wrappedDekFixture(), 'S3', aad, Buffer.from('1101700207364'))

    // ct region: after header(4) + wrappedDek + nonce(12), before the trailing tag(16).
    const wrappedLen = wrappedDekFixture().length
    const ctStart = HEADER_BYTES + wrappedLen + 12
    expect(sealed.length).toBeGreaterThan(ctStart + 16) // sanity: there is at least 1 byte of ct
    const tampered = Buffer.from(sealed)
    tampered.writeUInt8(tampered.readUInt8(ctStart) ^ 0x01, ctStart)

    expect(() => open(d, aad, tampered)).toThrow()
  })

  it('throws when a bit is flipped in the tag', () => {
    const d = dek()
    const aad = buildAad('emp-A', 'national_id')
    const sealed = seal(d, wrappedDekFixture(), 'S3', aad, Buffer.from('1101700207364'))

    const tampered = Buffer.from(sealed)
    const lastByteIndex = tampered.length - 1
    tampered.writeUInt8(tampered.readUInt8(lastByteIndex) ^ 0x01, lastByteIndex)

    expect(() => open(d, aad, tampered)).toThrow()
  })
})

describe('truncation', () => {
  const d = dek()
  const aad = buildAad('emp-A', 'national_id')
  const sealed = seal(d, wrappedDekFixture(), 'S3', aad, Buffer.from('1101700207364'))

  it.each([0, 1, 2, 3, 5, sealed.length - 1, sealed.length - 16, sealed.length - 20])(
    'throws when truncated at offset %i — never a partial decrypt',
    (cutAt) => {
      const truncated = sealed.subarray(0, Math.max(0, cutAt))
      expect(() => open(d, aad, truncated)).toThrow()
    },
  )
})

describe('length-prefix correctness', () => {
  it('the u16be prefix equals len(wrappedDEK) and parseHeader recovers exactly the bytes given to seal()', () => {
    const d = dek()
    const wrappedDek = wrappedDekFixture()
    const aad = buildAad('emp-A', 'national_id')
    const sealed = seal(d, wrappedDek, 'S3', aad, Buffer.from('1101700207364'))

    expect(sealed.readUInt16BE(2)).toBe(wrappedDek.length)
    expect(parseHeader(sealed).wrappedDek.equals(wrappedDek)).toBe(true)
  })

  it('round-trips a zero-length wrappedDek', () => {
    const d = dek()
    const aad = buildAad('emp-A', 'national_id')
    const sealed = seal(d, Buffer.alloc(0), 'S2', aad, Buffer.from('x'))

    expect(sealed.readUInt16BE(2)).toBe(0)
    expect(parseHeader(sealed).wrappedDek.length).toBe(0)
    expect(open(d, aad, sealed).toString('utf8')).toBe('x')
  })
})

describe('a declared wrappedDEK length larger than the remaining buffer', () => {
  const malformedHeader = (): Buffer => {
    const header = Buffer.alloc(HEADER_BYTES)
    header.writeUInt8(1, 0) // version 1
    header.writeUInt8(3, 1) // fieldClass S3
    header.writeUInt16BE(60000, 2) // declares 60000 bytes of wrappedDek
    return Buffer.concat([header, Buffer.alloc(5)]) // far short of 60000
  }

  it('parseHeader throws rather than trusting the header', () => {
    expect(() => parseHeader(malformedHeader())).toThrow()
  })

  it('open() throws rather than trusting the header', () => {
    const d = dek()
    const aad = buildAad('emp-A', 'national_id')

    expect(() => open(d, aad, malformedHeader())).toThrow()
  })
})

describe('version byte', () => {
  it('parseHeader accepts version 1 (the only version that exists)', () => {
    const sealed = seal(dek(), wrappedDekFixture(), 'S3', buildAad('e', 'f'), Buffer.from('x'))
    expect(parseHeader(sealed).version).toBe(1)
  })

  it('parseHeader throws on an unrecognised version — never defaults or ignores it', () => {
    const sealed = seal(dek(), wrappedDekFixture(), 'S3', buildAad('e', 'f'), Buffer.from('x'))
    const tampered = Buffer.from(sealed)
    tampered.writeUInt8(2, 0) // no version 2 exists

    expect(() => parseHeader(tampered)).toThrow()
    expect(() => open(dek(), buildAad('e', 'f'), tampered)).toThrow()
  })
})

describe('fieldClass byte', () => {
  it('parseHeader throws on an unrecognised fieldClass code — never defaults to S2 or S3', () => {
    const sealed = seal(dek(), wrappedDekFixture(), 'S3', buildAad('e', 'f'), Buffer.from('x'))
    const tampered = Buffer.from(sealed)
    tampered.writeUInt8(9, 1) // no fieldClass code 9 exists (S2=2, S3=3)

    expect(() => parseHeader(tampered)).toThrow()
    expect(() => open(dek(), buildAad('e', 'f'), tampered)).toThrow()
  })
})

describe('buildAad', () => {
  it('joins entityId and field with a colon', () => {
    expect(buildAad('emp-1', 'national_id').toString('utf8')).toBe('emp-1:national_id')
  })
})
