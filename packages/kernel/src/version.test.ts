import { buildVersion } from './version'

describe('buildVersion', () => {
  it('returns the injected git sha', () => {
    expect(buildVersion({ GADONG_BUILD_SHA: 'abc1234' } as NodeJS.ProcessEnv)).toBe('abc1234')
  })
  it('falls back to "dev" when absent', () => {
    expect(buildVersion({} as NodeJS.ProcessEnv)).toBe('dev')
  })
  it('falls back to "dev" when empty', () => {
    expect(buildVersion({ GADONG_BUILD_SHA: '' } as NodeJS.ProcessEnv)).toBe('dev')
  })
})
