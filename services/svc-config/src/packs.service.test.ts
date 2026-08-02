import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { RulesRepository } from './rules.repository'
import { PacksService, computePackSignature } from './packs.service'
import type { SignedPack } from './packs.service'
import { FakeConfigDb } from './testing/fake-db'

const SIGNING_KEY = 'test-signing-key'

function signedPack(overrides: Partial<SignedPack> = {}): SignedPack {
  const base: Omit<SignedPack, 'signature'> = {
    pack_id: 'TEST-PACK',
    version: 1,
    records: [
      {
        rule_key: 'leave.annual.min_days',
        value: 6,
        unit: 'days',
        statutory_floor: 6,
        statutory_ceiling: null,
        citation: 'LPA s.30',
        effective_from: '1998-08-19',
        effective_to: null,
        governance_class: 'STATUTORY_FLOOR',
      },
    ],
    ...overrides,
  }
  return { ...base, signature: computePackSignature(base, SIGNING_KEY), ...overrides }
}

function contentHash(db: FakeConfigDb): string {
  const canonical = JSON.stringify(
    db
      .debugRules()
      .map((r) => ({ ...r, id: undefined, created_at: undefined }))
      .sort((a, b) => `${a.rule_key}:${a.effective_from}`.localeCompare(`${b.rule_key}:${b.effective_from}`)),
  )
  return createHash('sha256').update(canonical).digest('hex')
}

describe('PacksService.importPack — signature verification', () => {
  it('blocks import and writes nothing when the signature does not verify', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), SIGNING_KEY)
    const tampered = signedPack()
    tampered.records[0]!.value = 999 // content changed after signing

    await conn.query('BEGIN')
    await expect(service.importPack(conn, tampered)).rejects.toMatchObject({ code: 'CFG-401' })
    await conn.query('ROLLBACK')

    expect(db.debugRules()).toHaveLength(0)
  })

  it('blocks import when the signature is simply wrong (not signed with this key)', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), SIGNING_KEY)
    const wrongKeyPack = signedPack()
    const wrongSig = computePackSignature(wrongKeyPack, 'a-different-key')

    await conn.query('BEGIN')
    await expect(service.importPack(conn, { ...wrongKeyPack, signature: wrongSig })).rejects.toMatchObject({
      code: 'CFG-401',
    })
    await conn.query('ROLLBACK')

    expect(db.debugRules()).toHaveLength(0)
  })

  it('accepts a correctly signed pack', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), SIGNING_KEY)

    await conn.query('BEGIN')
    const result = await service.importPack(conn, signedPack())
    await conn.query('COMMIT')

    expect(result).toMatchObject({ status: 'imported', ruleCount: 1 })
  })
})

describe('PacksService.importPack — idempotent by (pack_id, version)', () => {
  it('running the same pack twice produces identical row count and identical content hash', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), SIGNING_KEY)
    const pack = signedPack()

    await conn.query('BEGIN')
    const first = await service.importPack(conn, pack)
    await conn.query('COMMIT')
    const rowCountAfterFirst = db.debugRules().length
    const hashAfterFirst = contentHash(db)

    await conn.query('BEGIN')
    const second = await service.importPack(conn, pack)
    await conn.query('COMMIT')

    expect(first.status).toBe('imported')
    expect(second.status).toBe('duplicate')
    expect(db.debugRules()).toHaveLength(rowCountAfterFirst)
    expect(contentHash(db)).toBe(hashAfterFirst)
  })

  it('a different version of the same pack_id is not treated as a duplicate', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), SIGNING_KEY)

    await conn.query('BEGIN')
    await service.importPack(conn, signedPack({ version: 1 }))
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    const result = await service.importPack(
      conn,
      signedPack({
        version: 2,
        records: [
          {
            rule_key: 'leave.annual.min_days',
            value: 7,
            unit: 'days',
            statutory_floor: 6,
            statutory_ceiling: null,
            citation: 'LPA s.30',
            effective_from: '2027-01-01',
            effective_to: null,
            governance_class: 'STATUTORY_FLOOR',
          },
        ],
      }),
    )
    await conn.query('COMMIT')

    expect(result.status).toBe('imported')
    expect(db.debugRules()).toHaveLength(2)
  })
})

describe('PacksService.importPack — floor validation blocks a bad pack', () => {
  it('rejects and writes nothing when a record violates its own statutory floor', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), SIGNING_KEY)
    const badPack = signedPack({
      pack_id: 'BAD-PACK',
      records: [
        {
          rule_key: 'leave.annual.min_days',
          value: 4,
          unit: 'days',
          statutory_floor: 6,
          statutory_ceiling: null,
          citation: 'LPA s.30',
          effective_from: '1998-08-19',
          effective_to: null,
          governance_class: 'STATUTORY_FLOOR',
        },
      ],
    })

    await conn.query('BEGIN')
    await expect(service.importPack(conn, badPack)).rejects.toMatchObject({
      code: 'CFG-422',
      details: [expect.objectContaining({ citation: 'LPA s.30' })],
    })
    await conn.query('ROLLBACK')

    expect(db.debugRules()).toHaveLength(0)
  })
})

describe('The real seed packs shipped with this service', () => {
  const SEED_SIGNING_KEY = 'gadonghr-dev-pack-signing-key'

  function loadPack(fileName: string): SignedPack {
    const text = readFileSync(join(__dirname, '..', 'seed', fileName), 'utf8')
    return JSON.parse(text) as SignedPack
  }

  it('TH-STATUTORY-v1.json is correctly signed and loads with zero floor/ceiling violations', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), SEED_SIGNING_KEY)
    const pack = loadPack('TH-STATUTORY-v1.json')

    await conn.query('BEGIN')
    const result = await service.importPack(conn, pack)
    await conn.query('COMMIT')

    expect(result.status).toBe('imported')
    expect(result.ruleCount).toBe(pack.records.length)
    expect(db.debugRules()).toHaveLength(pack.records.length)
  })

  it('TH-HOLIDAYS-2026.json is correctly signed and loads with at least 13 holidays selected', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), SEED_SIGNING_KEY)
    const pack = loadPack('TH-HOLIDAYS-2026.json')

    await conn.query('BEGIN')
    const result = await service.importPack(conn, pack)
    await conn.query('COMMIT')

    expect(result.status).toBe('imported')
    const holidayList = pack.records[0]?.value as Array<{ date: string }>
    expect(holidayList.length).toBeGreaterThanOrEqual(13)
  })

  it('running the seeder (both real packs) twice produces identical row count and identical content hash', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), SEED_SIGNING_KEY)
    const statutory = loadPack('TH-STATUTORY-v1.json')
    const holidays = loadPack('TH-HOLIDAYS-2026.json')

    async function seedOnce(): Promise<void> {
      await conn.query('BEGIN')
      await service.importPack(conn, statutory)
      await conn.query('COMMIT')
      await conn.query('BEGIN')
      await service.importPack(conn, holidays)
      await conn.query('COMMIT')
    }

    await seedOnce()
    const rowCountAfterFirst = db.debugRules().length
    const hashAfterFirst = contentHash(db)

    await seedOnce()

    expect(db.debugRules()).toHaveLength(rowCountAfterFirst)
    expect(contentHash(db)).toBe(hashAfterFirst)
  })
})
