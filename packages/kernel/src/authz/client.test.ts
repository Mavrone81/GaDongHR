import { AuthzClient, AUTHZ_DECIDE_TIMEOUT_MS, DECISION_CACHE_MAX_ENTRIES, DECISION_CACHE_TTL_MS } from './client'
import type { AuthzTransport, Decision } from './client'

describe('AuthzClient.decide', () => {
  it('returns the decision svc-authz responds with', async () => {
    const decision: Decision = { allowed: true, scopeOrgUnitIds: '*' }
    const transport: AuthzTransport = { post: jest.fn().mockResolvedValue(decision) }
    const client = new AuthzClient(transport)

    await expect(client.decide('user-1', 'employee.read')).resolves.toEqual(decision)
  })

  it('fails closed (denies) when svc-authz is unreachable — an authz outage must never become a bypass', async () => {
    const transport: AuthzTransport = { post: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    const client = new AuthzClient(transport)

    await expect(client.decide('user-1', 'employee.read')).resolves.toEqual({
      allowed: false,
      scopeOrgUnitIds: [],
    })
  })

  it('fails closed when svc-authz returns a malformed response', async () => {
    const transport: AuthzTransport = { post: jest.fn().mockResolvedValue({ nonsense: true }) }
    const client = new AuthzClient(transport)

    await expect(client.decide('user-1', 'employee.read')).resolves.toEqual({
      allowed: false,
      scopeOrgUnitIds: [],
    })
  })

  it('caches a decision for the same user+permission and does not re-call the transport', async () => {
    const decision: Decision = { allowed: true, scopeOrgUnitIds: ['ou-1'] }
    const post = jest.fn().mockResolvedValue(decision)
    const client = new AuthzClient({ post })

    await client.decide('user-1', 'employee.read')
    await client.decide('user-1', 'employee.read')

    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keys the cache on user+permission, not permission alone, so one user cannot see another user\'s cached decision', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ allowed: true, scopeOrgUnitIds: '*' } satisfies Decision)
      .mockResolvedValueOnce({ allowed: false, scopeOrgUnitIds: [] } satisfies Decision)
    const client = new AuthzClient({ post })

    const forUser1 = await client.decide('user-1', 'payroll.run.approve')
    const forUser2 = await client.decide('user-2', 'payroll.run.approve')

    expect(forUser1.allowed).toBe(true)
    expect(forUser2.allowed).toBe(false)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('invalidateAll clears every cached decision so a revoked grant takes effect on the next decide', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ allowed: true, scopeOrgUnitIds: '*' } satisfies Decision)
      .mockResolvedValueOnce({ allowed: false, scopeOrgUnitIds: [] } satisfies Decision)
    const client = new AuthzClient({ post })

    const before = await client.decide('user-1', 'payroll.run.approve')
    client.invalidateAll()
    const after = await client.decide('user-1', 'payroll.run.approve')

    expect(before.allowed).toBe(true)
    expect(after.allowed).toBe(false)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('does not let a caller mutate the cached decision by mutating a previously returned Decision (fix round 1, IMPORTANT 2)', async () => {
    const post = jest.fn().mockResolvedValue({ allowed: true, scopeOrgUnitIds: ['ou-1'] } satisfies Decision)
    const client = new AuthzClient({ post })

    const first = await client.decide('user-1', 'employee.read')
    if (Array.isArray(first.scopeOrgUnitIds)) first.scopeOrgUnitIds.push('ou-mutated')
    first.allowed = false

    const second = await client.decide('user-1', 'employee.read')

    expect(second).toEqual({ allowed: true, scopeOrgUnitIds: ['ou-1'] })
    expect(post).toHaveBeenCalledTimes(1) // still cached — mutation neither evicted nor corrupted it
  })

  it('does not let a caller mutate a shared fail-closed DENIED decision across unrelated calls (fix round 1, IMPORTANT 2)', async () => {
    const post = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new AuthzClient({ post })

    const first = await client.decide('user-1', 'employee.read')
    if (Array.isArray(first.scopeOrgUnitIds)) first.scopeOrgUnitIds.push('ou-mutated')

    const second = await client.decide('user-2', 'employee.read')

    expect(second).toEqual({ allowed: false, scopeOrgUnitIds: [] })
  })

  it('expires a cached decision after DECISION_CACHE_TTL_MS so a revoked grant cannot outlive the TTL even if invalidateAll is never called (fix round 1, IMPORTANT 1)', async () => {
    let now = 0
    const post = jest
      .fn()
      .mockResolvedValueOnce({ allowed: true, scopeOrgUnitIds: '*' } satisfies Decision)
      .mockResolvedValueOnce({ allowed: false, scopeOrgUnitIds: [] } satisfies Decision)
    const client = new AuthzClient({ post }, { now: () => now })

    const before = await client.decide('user-1', 'payroll.run.approve')
    now += DECISION_CACHE_TTL_MS + 1
    const after = await client.decide('user-1', 'payroll.run.approve')

    expect(before.allowed).toBe(true)
    expect(after.allowed).toBe(false)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('does not re-query before the TTL elapses', async () => {
    let now = 0
    const post = jest.fn().mockResolvedValue({ allowed: true, scopeOrgUnitIds: '*' } satisfies Decision)
    const client = new AuthzClient({ post }, { now: () => now })

    await client.decide('user-1', 'payroll.run.approve')
    now += DECISION_CACHE_TTL_MS - 1
    await client.decide('user-1', 'payroll.run.approve')

    expect(post).toHaveBeenCalledTimes(1)
  })

  it('evicts the oldest entry once the cache would exceed DECISION_CACHE_MAX_ENTRIES (fix round 1, IMPORTANT 1)', async () => {
    const post = jest.fn().mockResolvedValue({ allowed: true, scopeOrgUnitIds: '*' } satisfies Decision)
    const client = new AuthzClient({ post })

    for (let i = 0; i < DECISION_CACHE_MAX_ENTRIES; i += 1) {
      await client.decide(`user-${i}`, 'employee.read')
    }
    // one more distinct entry pushes the cache past the bound and must evict user-0
    await client.decide(`user-${DECISION_CACHE_MAX_ENTRIES}`, 'employee.read')

    post.mockClear()
    await client.decide('user-0', 'employee.read')
    expect(post).toHaveBeenCalledTimes(1) // evicted — had to re-query

    post.mockClear()
    await client.decide(`user-${DECISION_CACHE_MAX_ENTRIES}`, 'employee.read')
    expect(post).toHaveBeenCalledTimes(0) // most recent entry — still cached
  }, 20_000)

  it('fails closed if svc-authz never responds (transport timeout) (fix round 1, IMPORTANT 5)', async () => {
    const post = jest.fn(() => new Promise<never>(() => undefined)) // never settles
    // A short injected timeout keeps this test fast; the default a caller
    // gets without passing `timeoutMs` is the exported AUTHZ_DECIDE_TIMEOUT_MS.
    const client = new AuthzClient({ post }, { timeoutMs: 10 })

    await expect(client.decide('user-1', 'employee.read')).resolves.toEqual({
      allowed: false,
      scopeOrgUnitIds: [],
    })
  })

  it('defaults to AUTHZ_DECIDE_TIMEOUT_MS when no timeoutMs is injected', () => {
    expect(AUTHZ_DECIDE_TIMEOUT_MS).toBe(5_000)
  })

  it('the cache key does not collide across a userId/permission split at the separator (fix round 1, MINOR)', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ allowed: true, scopeOrgUnitIds: '*' } satisfies Decision)
      .mockResolvedValueOnce({ allowed: false, scopeOrgUnitIds: [] } satisfies Decision)
    const client = new AuthzClient({ post })

    const first = await client.decide('a:b', 'c')
    const second = await client.decide('a', 'b:c')

    expect(first.allowed).toBe(true)
    expect(second.allowed).toBe(false)
    expect(post).toHaveBeenCalledTimes(2)
  })
})
