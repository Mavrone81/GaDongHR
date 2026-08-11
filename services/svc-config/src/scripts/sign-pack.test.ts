import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RulesRepository } from '../rules.repository'
import { PacksService } from '../packs.service'
import type { PackRecord, SignedPack } from '../packs.service'
import { FakeConfigDb } from '../testing/fake-db'
import { signPack, signPackFile, signPackFileInPlace } from './sign-pack'
import type { UnsignedPack } from './sign-pack'

const RECORDS: PackRecord[] = [
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
]

function unsignedPack(overrides: Partial<UnsignedPack> = {}): UnsignedPack {
  return { pack_id: 'TEST-PACK', version: 1, records: RECORDS, ...overrides }
}

describe('signPack', () => {
  it("produces a signature that PacksService accepts under the SAME key it signed with (the tool's output verifies)", async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    const service = new PacksService(new RulesRepository(conn), 'env-a-key')
    const signed = signPack(unsignedPack(), 'env-a-key')

    await conn.query('BEGIN')
    const result = await service.importPack(conn, signed)
    await conn.query('COMMIT')

    expect(result).toMatchObject({ status: 'imported', ruleCount: 1 })
  })

  it('reproduces the actual production failure: a pack signed with one environment\'s key (A) fails PacksService verification under a different environment\'s key (B)', async () => {
    const db = new FakeConfigDb()
    const conn = db.connect()
    // "authoring" key vs. a different "deployment" key — exactly the
    // TH-STATUTORY-v1 / TH-HOLIDAYS-2026 production failure: a signature
    // baked in with one CONFIG_PACK_SIGNING_KEY is presented to a service
    // running with a different, independently generated one.
    const signedForEnvA = signPack(unsignedPack(), 'env-a-key')
    const serviceForEnvB = new PacksService(new RulesRepository(conn), 'env-b-key')

    await conn.query('BEGIN')
    await expect(serviceForEnvB.importPack(conn, signedForEnvA)).rejects.toMatchObject({ code: 'CFG-401' })
    await conn.query('ROLLBACK')

    expect(db.debugRules()).toHaveLength(0)
  })

  it('ignores and overwrites any signature already present on the input, rather than trusting it', () => {
    const stale: SignedPack = { ...unsignedPack(), signature: 'not-a-real-signature==' }
    const resigned = signPack(stale, 'env-a-key')

    expect(resigned.signature).not.toBe('not-a-real-signature==')
    expect(resigned.signature).toBe(signPack(unsignedPack(), 'env-a-key').signature)
  })
})

describe('signPackFile / signPackFileInPlace', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sign-pack-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('signPackFile reads an UnsignedPack (no signature field, the committed seed-file shape) and signs it without touching disk', () => {
    const filePath = join(dir, 'pack.json')
    writeFileSync(filePath, JSON.stringify(unsignedPack()), 'utf8')

    const signed = signPackFile(filePath, 'env-a-key')

    expect(signed.signature).toBe(signPack(unsignedPack(), 'env-a-key').signature)
    // untouched on disk — signPackFile never writes
    expect(JSON.parse(readFileSync(filePath, 'utf8')) as unknown).toEqual(unsignedPack())
  })

  it('signPackFileInPlace overwrites the file with valid, re-loadable JSON carrying the computed signature', () => {
    const filePath = join(dir, 'pack.json')
    writeFileSync(filePath, JSON.stringify(unsignedPack()), 'utf8')

    const signed = signPackFileInPlace(filePath, 'env-a-key')

    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as SignedPack
    expect(onDisk).toEqual(signed)
    expect(onDisk.signature).toBe(signPack(unsignedPack(), 'env-a-key').signature)
  })

  it('running signPackFileInPlace twice with the same key is a no-op on content (idempotent re-signing)', () => {
    const filePath = join(dir, 'pack.json')
    writeFileSync(filePath, JSON.stringify(unsignedPack()), 'utf8')

    const first = signPackFileInPlace(filePath, 'env-a-key')
    const second = signPackFileInPlace(filePath, 'env-a-key')

    expect(second).toEqual(first)
  })
})
