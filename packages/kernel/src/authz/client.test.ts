import { AuthzClient } from './client'
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
})
