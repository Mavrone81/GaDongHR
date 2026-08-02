import { GadongError, cryptoUnavailable, permissionDenied, sodViolation } from './errors'

describe('GadongError', () => {
  it('serialises to the standard envelope', () => {
    expect(new GadongError('ONB-001','onboarding.error.invalid_national_id',422).toEnvelope())
      .toEqual({ code:'ONB-001', message_i18n_key:'onboarding.error.invalid_national_id', details: [] })
  })
  it('carries details', () => {
    expect(new GadongError('ONB-001','k',422,[{ field:'nationalId' }]).toEnvelope().details)
      .toEqual([{ field:'nationalId' }])
  })
})

describe('reserved errors', () => {
  it('crypto unavailable fails closed with 503', () => {
    const e = cryptoUnavailable()
    expect(e.code).toBe('CRY-503'); expect(e.httpStatus).toBe(503)
  })
  it('permission denied is 403 and names the permission', () => {
    const e = permissionDenied('payroll.run.approve')
    expect(e.code).toBe('AUZ-403'); expect(e.httpStatus).toBe(403)
    expect(e.details).toEqual([{ permission: 'payroll.run.approve' }])
  })
  it('SoD violation is 409', () => {
    expect(sodViolation('prepared_by != approved_by').httpStatus).toBe(409)
  })
})
