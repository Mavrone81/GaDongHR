import { EntriesService } from './entries.service'
import { EntriesRepository } from './entries.repository'
import type { StoredEntry } from './chain'
import { GENESIS_PREV_HASH, computeEntryHash } from './chain'

const ENTRY_DEFAULTS = {
  id: '1',
  occurredAt: '2026-08-01T00:00:00.000Z',
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

/** Builds a `StoredEntry` whose `entryHash` is a genuine hash of ITS OWN (possibly overridden) content — unlike a naive spread-after-hash helper, overriding `entityId` etc. here changes the hash that gets computed, not just the field. */
function fakeEntry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  const merged = { ...ENTRY_DEFAULTS, ...overrides }
  const content = {
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
  return { id: merged.id, ...content, prevEntryHash: merged.prevEntryHash, entryHash }
}

type FakeRepo = Pick<EntriesRepository, 'findPage' | 'findAllOrdered'>

function fakeRepo(overrides: Partial<FakeRepo> = {}): EntriesRepository {
  const base: FakeRepo = {
    findPage: jest.fn().mockResolvedValue([]),
    findAllOrdered: jest.fn().mockResolvedValue([]),
    ...overrides,
  }
  return base as EntriesRepository
}

describe('EntriesService.list', () => {
  it('defaults to page 1 when no page is given', async () => {
    const findPage = jest.fn().mockResolvedValue([fakeEntry()])
    const service = new EntriesService(fakeRepo({ findPage }))

    const result = await service.list({})

    expect(result.page).toBe(1)
    expect(findPage).toHaveBeenCalledWith({ entity: undefined, entityId: undefined, from: undefined, to: undefined }, 1)
  })

  it('forwards a valid page number', async () => {
    const findPage = jest.fn().mockResolvedValue([])
    const service = new EntriesService(fakeRepo({ findPage }))

    await service.list({ page: 3 })

    expect(findPage).toHaveBeenCalledWith(expect.anything(), 3)
  })

  it.each([0, -1, NaN])('falls back to page 1 for an invalid page value (%p)', async (invalid) => {
    const findPage = jest.fn().mockResolvedValue([])
    const service = new EntriesService(fakeRepo({ findPage }))

    const result = await service.list({ page: invalid })

    expect(result.page).toBe(1)
    expect(findPage).toHaveBeenCalledWith(expect.anything(), 1)
  })

  it('forwards entity/entityId/from/to filters', async () => {
    const findPage = jest.fn().mockResolvedValue([])
    const service = new EntriesService(fakeRepo({ findPage }))

    await service.list({ entity: 'employee', entityId: 'emp-1', from: '2026-01-01', to: '2026-12-31' })

    expect(findPage).toHaveBeenCalledWith({ entity: 'employee', entityId: 'emp-1', from: '2026-01-01', to: '2026-12-31' }, 1)
  })
})

describe('EntriesService.verify', () => {
  it('delegates to chain.ts verifyChain over every entry', async () => {
    const first = fakeEntry({ id: '1' })
    const second = fakeEntry({ id: '2', entityId: 'emp-2', prevEntryHash: first.entryHash })
    const findAllOrdered = jest.fn().mockResolvedValue([first, second])
    const service = new EntriesService(fakeRepo({ findAllOrdered }))

    const result = await service.verify()

    expect(result).toEqual({ valid: true, entryCount: 2, issues: [] })
  })

  it('surfaces a tampered entry by id, matching chain.ts#verifyChain directly', async () => {
    const first = fakeEntry({ id: '1' })
    const tampered = { ...fakeEntry({ id: '2', entityId: 'emp-2', prevEntryHash: first.entryHash }), entityId: 'emp-tampered' }
    const findAllOrdered = jest.fn().mockResolvedValue([first, tampered])
    const service = new EntriesService(fakeRepo({ findAllOrdered }))

    const result = await service.verify()

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual([expect.objectContaining({ entryId: '2', kind: 'content_mismatch' })])
  })

  it('an empty log verifies as valid', async () => {
    const service = new EntriesService(fakeRepo())

    expect(await service.verify()).toEqual({ valid: true, entryCount: 0, issues: [] })
  })
})
