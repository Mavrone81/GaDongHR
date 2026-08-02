import { EntriesRepository, PAGE_SIZE } from './entries.repository'
import type { NewEntryInput } from './entries.repository'
import { FakeAuditDb } from './testing/fake-db'
import { GENESIS_PREV_HASH, computeEntryHash } from './chain'
import type { ChainContent } from './chain'

const DEFAULTS = {
  occurredAt: '2026-08-01T09:00:00.000Z',
  actorId: 'user-1',
  actorRole: 'hr-officer',
  action: 'employee.update',
  entity: 'employee',
  entityId: 'emp-1',
  purpose: null as string | null,
  beforeHash: null as string | null,
  afterHash: null as string | null,
  prevEntryHash: GENESIS_PREV_HASH,
}

function newEntryInput(overrides: Partial<NewEntryInput> = {}): NewEntryInput {
  const merged = { ...DEFAULTS, ...overrides }
  const content: ChainContent = {
    occurredAt: merged.occurredAt,
    actorId: merged.actorId,
    actorRole: merged.actorRole,
    action: merged.action,
    entity: merged.entity,
    entityId: merged.entityId,
    purpose: merged.purpose,
    beforeHash: merged.beforeHash,
    afterHash: merged.afterHash,
  }
  const entryHash = overrides.entryHash ?? computeEntryHash(merged.prevEntryHash, content)
  return { ...content, prevEntryHash: merged.prevEntryHash, entryHash }
}

describe('EntriesRepository.insert / findLatest', () => {
  it('inserts a row and assigns it an id', async () => {
    const db = new FakeAuditDb()
    const repo = new EntriesRepository(db.asPool())
    const tx = db.connect()

    await tx.query('BEGIN')
    const inserted = await repo.insert(tx, newEntryInput())
    await tx.query('COMMIT')

    expect(inserted.id).toBe('1')
    expect(inserted.entity).toBe('employee')
    expect(inserted.prevEntryHash).toBe(GENESIS_PREV_HASH)
  })

  it('findLatest returns null for an empty log', async () => {
    const db = new FakeAuditDb()
    const repo = new EntriesRepository(db.asPool())
    const tx = db.connect()

    await tx.query('BEGIN')
    const latest = await repo.findLatest(tx)
    await tx.query('COMMIT')

    expect(latest).toBeNull()
  })

  it('findLatest returns the highest-id row after inserts', async () => {
    const db = new FakeAuditDb()
    const repo = new EntriesRepository(db.asPool())

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    const first = await repo.insert(tx1, newEntryInput())
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const second = await repo.insert(tx2, newEntryInput({ prevEntryHash: first.entryHash, entryHash: undefined }))
    await tx2.query('COMMIT')

    const tx3 = db.connect()
    await tx3.query('BEGIN')
    const latest = await repo.findLatest(tx3)
    await tx3.query('COMMIT')

    expect(latest?.id).toBe(second.id)
  })

  it('an insert made in a transaction that is rolled back is not visible afterwards', async () => {
    const db = new FakeAuditDb()
    const repo = new EntriesRepository(db.asPool())
    const tx = db.connect()

    await tx.query('BEGIN')
    await repo.insert(tx, newEntryInput())
    await tx.query('ROLLBACK')

    expect(db.debugEntries()).toHaveLength(0)
  })

  it('has no update or delete method — append-only at the application layer, not merely by DB grant', () => {
    const repoProto = EntriesRepository.prototype as unknown as Record<string, unknown>
    expect(repoProto['update']).toBeUndefined()
    expect(repoProto['delete']).toBeUndefined()
    expect(repoProto['updateEntry']).toBeUndefined()
    expect(repoProto['deleteEntry']).toBeUndefined()
  })
})

describe('EntriesRepository.findPage', () => {
  async function seed(db: FakeAuditDb, entries: Array<{ entity: string; entityId: string; occurredAt: string }>): Promise<void> {
    const repo = new EntriesRepository(db.asPool())
    let prevEntryHash = GENESIS_PREV_HASH
    for (const e of entries) {
      const tx = db.connect()
      await tx.query('BEGIN')
      const inserted = await repo.insert(
        tx,
        newEntryInput({ entity: e.entity, entityId: e.entityId, occurredAt: e.occurredAt, prevEntryHash, entryHash: undefined }),
      )
      await tx.query('COMMIT')
      prevEntryHash = inserted.entryHash
    }
  }

  it('filters by entity and entityId', async () => {
    const db = new FakeAuditDb()
    await seed(db, [
      { entity: 'employee', entityId: 'emp-1', occurredAt: '2026-08-01T00:00:00.000Z' },
      { entity: 'employee', entityId: 'emp-2', occurredAt: '2026-08-01T01:00:00.000Z' },
      { entity: 'payrun', entityId: 'run-1', occurredAt: '2026-08-01T02:00:00.000Z' },
    ])
    const repo = new EntriesRepository(db.asPool())

    const byEntity = await repo.findPage({ entity: 'employee' }, 1)
    expect(byEntity).toHaveLength(2)

    const byEntityId = await repo.findPage({ entity: 'employee', entityId: 'emp-2' }, 1)
    expect(byEntityId).toHaveLength(1)
    expect(byEntityId[0]?.entityId).toBe('emp-2')
  })

  it('filters by from/to occurred_at range', async () => {
    const db = new FakeAuditDb()
    await seed(db, [
      { entity: 'employee', entityId: 'emp-1', occurredAt: '2026-01-01T00:00:00.000Z' },
      { entity: 'employee', entityId: 'emp-2', occurredAt: '2026-06-01T00:00:00.000Z' },
      { entity: 'employee', entityId: 'emp-3', occurredAt: '2026-12-01T00:00:00.000Z' },
    ])
    const repo = new EntriesRepository(db.asPool())

    const inRange = await repo.findPage({ from: '2026-02-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' }, 1)

    expect(inRange).toHaveLength(1)
    expect(inRange[0]?.entityId).toBe('emp-2')
  })

  it('paginates with PAGE_SIZE per page, oldest first', async () => {
    const db = new FakeAuditDb()
    const many = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => ({
      entity: 'employee',
      entityId: `emp-${i + 1}`,
      occurredAt: `2026-08-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
    }))
    await seed(db, many)
    const repo = new EntriesRepository(db.asPool())

    const page1 = await repo.findPage({}, 1)
    const page2 = await repo.findPage({}, 2)

    expect(page1).toHaveLength(PAGE_SIZE)
    expect(page2).toHaveLength(5)
    expect(page1[0]?.entityId).toBe('emp-1')
    expect(page2[0]?.entityId).toBe(`emp-${PAGE_SIZE + 1}`)
  })

  it('with no filters returns everything, paged', async () => {
    const db = new FakeAuditDb()
    await seed(db, [
      { entity: 'employee', entityId: 'emp-1', occurredAt: '2026-08-01T00:00:00.000Z' },
      { entity: 'payrun', entityId: 'run-1', occurredAt: '2026-08-01T01:00:00.000Z' },
    ])
    const repo = new EntriesRepository(db.asPool())

    const all = await repo.findPage({}, 1)

    expect(all).toHaveLength(2)
  })
})

describe('EntriesRepository.findAllOrdered', () => {
  it('returns every entry in id (chain) order', async () => {
    const db = new FakeAuditDb()
    const repo = new EntriesRepository(db.asPool())
    let prevEntryHash = GENESIS_PREV_HASH
    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      const inserted = await repo.insert(tx, newEntryInput({ entityId: `emp-${i}`, prevEntryHash, entryHash: undefined }))
      await tx.query('COMMIT')
      prevEntryHash = inserted.entryHash
    }

    const all = await repo.findAllOrdered()

    expect(all.map((e) => e.id)).toEqual(['1', '2', '3'])
  })

  it('returns an empty array for an empty log', async () => {
    const db = new FakeAuditDb()
    const repo = new EntriesRepository(db.asPool())

    expect(await repo.findAllOrdered()).toEqual([])
  })
})
