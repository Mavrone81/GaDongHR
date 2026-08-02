import { resolveEffective } from './effective-date'

const SSO_CEILING = [
  { effectiveFrom: '2020-01-01', effectiveTo: '2025-12-31', value: 15000 },
  { effectiveFrom: '2026-01-01', effectiveTo: null,         value: 17500 },
]
const EWF = [
  { effectiveFrom: '2026-10-01', effectiveTo: '2031-09-30', value: 0.25 },
  { effectiveFrom: '2031-10-01', effectiveTo: null,         value: 0.50 },
]

describe('resolveEffective', () => {
  it('picks the window containing the date',   () => expect(resolveEffective(SSO_CEILING,'2025-06-15')?.value).toBe(15000))
  it('effectiveFrom is inclusive',             () => expect(resolveEffective(SSO_CEILING,'2026-01-01')?.value).toBe(17500))
  it('effectiveTo is inclusive',               () => expect(resolveEffective(SSO_CEILING,'2025-12-31')?.value).toBe(15000))
  it('resolves an open-ended window',          () => expect(resolveEffective(SSO_CEILING,'2099-01-01')?.value).toBe(17500))
  // PRD M7-2 AC: Sept 2026 applies no EWF, Oct 2026 applies 0.25%, no code change.
  it('returns null before the first window',   () => expect(resolveEffective(EWF,'2026-09-30')).toBeNull())
  it('opens exactly on the effective date',    () => expect(resolveEffective(EWF,'2026-10-01')?.value).toBe(0.25))
  it('handles an empty set',                   () => expect(resolveEffective([],'2026-01-01')).toBeNull())
  it('is order-independent',                   () => expect(resolveEffective([...SSO_CEILING].reverse(),'2025-06-15')?.value).toBe(15000))
})
