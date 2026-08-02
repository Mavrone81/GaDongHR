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
})
