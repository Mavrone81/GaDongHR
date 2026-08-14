import { resolveScopedEmployeeIds, scopeAllowsEmployee, scopeAllowsOrgUnit } from './scope'

describe('scopeAllowsOrgUnit', () => {
  it('"*" allows any org unit', () => {
    expect(scopeAllowsOrgUnit('*', 'org-a')).toBe(true)
  })
  it('"self" allows no org unit at all', () => {
    expect(scopeAllowsOrgUnit('self', 'org-a')).toBe(false)
  })
  it('an array allows only listed org units', () => {
    expect(scopeAllowsOrgUnit(['org-a'], 'org-a')).toBe(true)
    expect(scopeAllowsOrgUnit(['org-a'], 'org-b')).toBe(false)
  })
  it('an empty array allows nothing', () => {
    expect(scopeAllowsOrgUnit([], 'org-a')).toBe(false)
  })
})

describe('scopeAllowsEmployee', () => {
  it('"*" allows any employee', () => {
    expect(scopeAllowsEmployee('*', 'caller', 'someone-else', null)).toBe(true)
  })
  it('"self" allows only the caller\'s own id, regardless of org unit', () => {
    expect(scopeAllowsEmployee('self', 'caller-1', 'caller-1', 'org-a')).toBe(true)
    expect(scopeAllowsEmployee('self', 'caller-1', 'someone-else', 'org-a')).toBe(false)
  })
  it('an array allows an employee whose org unit is listed', () => {
    expect(scopeAllowsEmployee(['org-a'], 'caller', 'target', 'org-a')).toBe(true)
    expect(scopeAllowsEmployee(['org-a'], 'caller', 'target', 'org-b')).toBe(false)
  })
  it('an array fails closed when the target employee has no known org unit yet', () => {
    expect(scopeAllowsEmployee(['org-a'], 'caller', 'target', null)).toBe(false)
  })
})

describe('resolveScopedEmployeeIds', () => {
  it('"*" resolves to null (every employee)', async () => {
    const result = await resolveScopedEmployeeIds('*', 'caller', async () => {
      throw new Error('should not be called for "*"')
    })
    expect(result).toBeNull()
  })
  it('"self" resolves to exactly [callerId]', async () => {
    const result = await resolveScopedEmployeeIds('self', 'caller-1', async () => {
      throw new Error('should not be called for "self"')
    })
    expect(result).toEqual(['caller-1'])
  })
  it('an org-unit array resolves via the lookup function', async () => {
    const result = await resolveScopedEmployeeIds(['org-a', 'org-b'], 'caller', async (orgUnitIds) => {
      expect(orgUnitIds).toEqual(['org-a', 'org-b'])
      return ['emp-1', 'emp-2']
    })
    expect(result).toEqual(['emp-1', 'emp-2'])
  })
  it('an empty array short-circuits to an empty employee list without calling the lookup', async () => {
    const result = await resolveScopedEmployeeIds([], 'caller', async () => {
      throw new Error('should not be called for an empty scope')
    })
    expect(result).toEqual([])
  })
})
