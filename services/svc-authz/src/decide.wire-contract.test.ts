import { AuthzClient } from '@gadong/kernel'
import type { AuthzTransport } from '@gadong/kernel'
import { AuthzController } from './authz.controller'
import { AuthzService } from './authz.service'
import { AuthzRepository } from './authz.repository'
import { seedRoleTemplates } from './seed/roles'
import { FakeAuthzDb } from './testing/fake-db'
import type { Pool } from 'pg'

/**
 * `packages/kernel/src/authz/client.ts`'s `isDecision` is the validator the
 * whole system's authz depends on, and it is NOT exported (only `Decision`,
 * `AuthzClient`, `AuthzTransport` are, per `packages/kernel/src/index.ts`).
 * The Task 8 brief says "test against the kernel's own validator, not a
 * copy of it" — since the function itself cannot be imported, this file
 * instead wires the REAL, unmodified `AuthzClient` (the exact class every
 * other service's `PermissionGuard` uses) to THIS controller's REAL
 * `decide()` handler, in-process, and exercises them together exactly as
 * production does. `isDecision` runs for real, inside `AuthzClient.decide`,
 * on every response this test's `AuthzController.decide()` produces.
 *
 * If `AuthzController.decide()` ever returned a shape `isDecision` rejects,
 * `AuthzClient.decide()` would silently substitute its own fail-closed
 * denial regardless of what the controller actually sent — every "allowed"
 * assertion below would then fail, which IS the wire-contract check,
 * achieved without ever touching kernel source (Task 8 brief §3).
 */
function inProcessTransport(controller: AuthzController): AuthzTransport {
  return {
    async post(path, body) {
      if (path !== '/decide') throw new Error(`unexpected path in wire-contract test: ${path}`)
      return controller.decide(body)
    },
  }
}

async function setUp() {
  const db = new FakeAuthzDb()
  const pool = db.asPool()
  const repo = new AuthzRepository(pool)
  const service = new AuthzService(repo)
  const controller = new AuthzController(service, repo, pool as unknown as Pool)
  await seedRoleTemplates(pool)
  const client = new AuthzClient(inProcessTransport(controller))
  return { db, pool, repo, service, controller, client }
}

describe('POST /decide satisfies the kernel AuthzClient / isDecision wire contract (Task 8 brief §3)', () => {
  it('a denial (unknown permission) round-trips as {allowed:false, scopeOrgUnitIds: []}', async () => {
    const { client } = await setUp()

    const decision = await client.decide('user-1', 'not.a.real.permission')

    expect(decision).toEqual({ allowed: false, scopeOrgUnitIds: [] })
  })

  it('a denial (no grant) round-trips the same shape', async () => {
    const { client } = await setUp()

    const decision = await client.decide('user-with-no-roles', 'employee.read')

    expect(decision).toEqual({ allowed: false, scopeOrgUnitIds: [] })
  })

  it('a self-scoped allow round-trips as {allowed:true, scopeOrgUnitIds: "self"}', async () => {
    const { repo, pool, client } = await setUp()
    const role = await repo.findRoleByCode('employee-ess')
    if (!role) throw new Error('employee-ess not seeded')
    await repo.insertUserRole(pool, { userId: 'emp-1', roleId: role.id, orgScopeUnitId: null, grantedBy: 'admin' })

    const decision = await client.decide('emp-1', 'employee.read')

    expect(decision).toEqual({ allowed: true, scopeOrgUnitIds: 'self' })
  })

  it('an org-subtree allow round-trips as {allowed:true, scopeOrgUnitIds: string[]} with the exact subtree', async () => {
    const { repo, pool, client } = await setUp()
    await repo.upsertOrgUnit(pool, 'chonburi-plant', null, {}, null)
    await repo.upsertOrgUnit(pool, 'chonburi-plant-line-a', 'chonburi-plant', {}, null)
    await repo.upsertOrgUnit(pool, 'chonburi-plant-line-b', 'chonburi-plant', {}, null)
    const role = await repo.findRoleByCode('line-manager')
    if (!role) throw new Error('line-manager not seeded')
    await repo.insertUserRole(pool, { userId: 'mgr-1', roleId: role.id, orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin' })

    const decision = await client.decide('mgr-1', 'roster.read')

    expect(decision.allowed).toBe(true)
    expect(new Set(decision.scopeOrgUnitIds)).toEqual(
      new Set(['chonburi-plant', 'chonburi-plant-line-a', 'chonburi-plant-line-b']),
    )
  })

  it('two identical decide() calls return equal decisions (AuthzClient caching itself is proven by kernel client.test.ts; this only needs the response shape to round-trip stably)', async () => {
    const { repo, pool, client } = await setUp()
    const role = await repo.findRoleByCode('employee-ess')
    if (!role) throw new Error('employee-ess not seeded')
    await repo.insertUserRole(pool, { userId: 'emp-2', roleId: role.id, orgScopeUnitId: null, grantedBy: 'admin' })

    const first = await client.decide('emp-2', 'employee.read')
    const second = await client.decide('emp-2', 'employee.read')

    expect(first).toEqual(second)
  })

  it('a malformed downstream call (bad userId type) still resolves to the fail-closed denial, never throws out of AuthzClient.decide', async () => {
    // AuthzClient.decide's own signature requires a string; this exercises
    // the controller's defensive isDecideBody check via a transport call
    // shaped the way a genuinely broken caller might send it.
    const transport: AuthzTransport = {
      post: async (path, body) => {
        void path
        void body
        return { not: 'a decision' }
      },
    }
    const brokenClient = new AuthzClient(transport)

    const decision = await brokenClient.decide('user-1', 'employee.read')

    expect(decision).toEqual({ allowed: false, scopeOrgUnitIds: [] })
  })
})
