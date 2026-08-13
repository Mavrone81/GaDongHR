import { buildHealth } from './health'
const env = { GADONG_BUILD_SHA: 'deadbee' } as NodeJS.ProcessEnv

describe('buildHealth', () => {
  it('ok when all dependencies are up', () => {
    expect(buildHealth('svc-config', { db:'up' }, env))
      .toEqual({ status:'ok', service:'svc-config', version:'deadbee', dependencies:{ db:'up' } })
  })
  it('degraded when any is down', () => {
    expect(buildHealth('svc-config', { db:'up', vault:'down' }, env).status).toBe('degraded')
  })
  it('ok with no dependencies', () => {
    expect(buildHealth('svc-i18n', {}, env).status).toBe('ok')
  })

  it('omits `outbox` entirely for a service that does not pass it — existing four-field callers keep an unchanged response shape', () => {
    const result = buildHealth('svc-config', { db: 'up' }, env)
    expect(result).toEqual({ status: 'ok', service: 'svc-config', version: 'deadbee', dependencies: { db: 'up' } })
    expect(result.outbox).toBeUndefined()
  })

  it('stays ok when the outbox is empty', () => {
    const result = buildHealth('svc-payroll', { db: 'up' }, env, { pending: 0, oldestAgeSeconds: null })
    expect(result.status).toBe('ok')
    expect(result.outbox).toEqual({ pending: 0, oldestAgeSeconds: null, stale: false })
  })

  it('degrades when the outbox is stale, even though every dependency is up — a stuck relay must be visible here', () => {
    const result = buildHealth('svc-payroll', { db: 'up' }, env, { pending: 5, oldestAgeSeconds: 600 })
    expect(result.status).toBe('degraded')
    expect(result.outbox).toEqual({ pending: 5, oldestAgeSeconds: 600, stale: true })
  })

  it('does not degrade on a merely-busy (not stale) outbox', () => {
    const result = buildHealth('svc-payroll', { db: 'up' }, env, { pending: 40, oldestAgeSeconds: 2 })
    expect(result.status).toBe('ok')
  })
})
