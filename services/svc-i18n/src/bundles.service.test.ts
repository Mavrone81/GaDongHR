import { BundlesService } from './bundles.service'
import type { RawBundles, WarnLogger } from './bundles.service'

function fakeLogger(): WarnLogger & { warn: jest.Mock } {
  return { warn: jest.fn() }
}

function fixture(overrides: Partial<RawBundles> = {}): RawBundles {
  return {
    en: {
      leave: { request: { submit: 'Submit leave request' } },
      glossary: { salary: 'Salary / wage', payslip: 'Payslip' },
      common: { save: 'Save' },
    },
    th: {
      leave: { request: { submit: 'ส่งคำขอลา' } },
      glossary: { salary: 'เงินเดือน / ค่าจ้าง' }, // payslip deliberately missing
      common: { save: 'บันทึก' },
    },
    zh: {
      leave: { request: {} }, // submit deliberately missing
      glossary: { salary: '工资', payslip: '工资条' },
      common: { save: '保存' },
    },
    ...overrides,
  }
}

describe('BundlesService.isSupportedLocale', () => {
  it.each(['th', 'en', 'zh'])('accepts %s', (locale) => {
    expect(BundlesService.isSupportedLocale(locale)).toBe(true)
  })

  it.each(['fr', 'TH', 'th-TH', ''])('rejects %j', (locale) => {
    expect(BundlesService.isSupportedLocale(locale)).toBe(false)
  })
})

describe('BundlesService — fallback chain', () => {
  it('returns the value directly when present in the requested locale', () => {
    const svc = new BundlesService(fixture(), fakeLogger())
    expect(svc.resolveKey('th', 'leave.request.submit')).toBe('ส่งคำขอลา')
  })

  it('falls back to en and logs a warning naming the key and locale when missing in th', () => {
    const logger = fakeLogger()
    const svc = new BundlesService(fixture(), logger)

    const value = svc.resolveKey('th', 'glossary.payslip')

    expect(value).toBe('Payslip')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [message] = logger.warn.mock.calls[0] as [string]
    expect(message).toContain('glossary.payslip')
    expect(message).toContain('th')
  })

  it('falls back to en and logs a warning naming the key and locale when missing in zh', () => {
    const logger = fakeLogger()
    const svc = new BundlesService(fixture(), logger)

    const value = svc.resolveKey('zh', 'leave.request.submit')

    expect(value).toBe('Submit leave request')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [message] = logger.warn.mock.calls[0] as [string]
    expect(message).toContain('leave.request.submit')
    expect(message).toContain('zh')
  })

  it('returns the key itself — never empty, never undefined — when missing everywhere including en', () => {
    const logger = fakeLogger()
    const svc = new BundlesService(fixture(), logger)

    const value = svc.resolveKey('th', 'nonexistent.totally.missing')

    expect(value).toBe('nonexistent.totally.missing')
    expect(value.length).toBeGreaterThan(0)
  })

  it('does not log a warning when resolving en itself, even for a key missing everywhere', () => {
    const logger = fakeLogger()
    const svc = new BundlesService(fixture(), logger)

    svc.resolveKey('en', 'nonexistent.totally.missing')

    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('BundlesService — missing-key accounting', () => {
  it('lists the exact missing keys per non-en locale (not just a count)', () => {
    const svc = new BundlesService(fixture())
    expect(svc.missingKeys('th')).toEqual(['glossary.payslip'])
    expect(svc.missingKeys('zh')).toEqual(['leave.request.submit'])
  })

  it('en has no missing keys by definition (it is the canonical key set)', () => {
    const svc = new BundlesService(fixture())
    expect(svc.missingKeys('en')).toEqual([])
  })

  it('getMissingKeyCounts reports a count per locale, measurable without scraping logs', () => {
    const svc = new BundlesService(fixture())
    expect(svc.getMissingKeyCounts()).toEqual({ th: 1, en: 0, zh: 1 })
  })

  it('a fully parallel fixture reports zero missing keys everywhere', () => {
    const svc = new BundlesService(
      fixture({
        th: {
          leave: { request: { submit: 'ส่งคำขอลา' } },
          glossary: { salary: 'เงินเดือน / ค่าจ้าง', payslip: 'สลิปเงินเดือน' },
          common: { save: 'บันทึก' },
        },
        zh: {
          leave: { request: { submit: '提交请假申请' } },
          glossary: { salary: '工资', payslip: '工资条' },
          common: { save: '保存' },
        },
      }),
    )
    expect(svc.getMissingKeyCounts()).toEqual({ th: 0, en: 0, zh: 0 })
  })
})

describe('BundlesService.getBundle', () => {
  it('returns every en-canonical key, resolved for the requested locale', () => {
    const svc = new BundlesService(fixture())
    const bundle = svc.getBundle('th')
    expect(bundle).toEqual({
      'leave.request.submit': 'ส่งคำขอลา',
      'glossary.salary': 'เงินเดือน / ค่าจ้าง',
      'glossary.payslip': 'Payslip', // fell back to en
      'common.save': 'บันทึก',
    })
  })

  it('filters to only the requested namespace', () => {
    const svc = new BundlesService(fixture())
    const bundle = svc.getBundle('en', 'leave')
    expect(Object.keys(bundle)).toEqual(['leave.request.submit'])
    expect(bundle['leave.request.submit']).toBe('Submit leave request')
  })

  it('an unknown namespace filter yields an empty bundle, not an error', () => {
    const svc = new BundlesService(fixture())
    expect(svc.getBundle('en', 'does-not-exist')).toEqual({})
  })
})

describe('BundlesService.getGlossary', () => {
  it('zips every glossary.* key across all three locales', () => {
    const svc = new BundlesService(fixture())
    const terms = svc.getGlossary()
    expect(terms).toContainEqual({ key: 'salary', en: 'Salary / wage', th: 'เงินเดือน / ค่าจ้าง', zh: '工资' })
    // th glossary.payslip is missing in this fixture — glossary lookup uses
    // the same fallback chain, so it still reports the en value, not undefined.
    expect(terms).toContainEqual({ key: 'payslip', en: 'Payslip', th: 'Payslip', zh: '工资条' })
  })
})

describe('BundlesService — Thai and Simplified Chinese round-trip unmangled', () => {
  it('a Thai string with combining marks is byte-identical in and out', () => {
    const svc = new BundlesService(fixture())
    expect(svc.resolveKey('th', 'glossary.salary')).toBe('เงินเดือน / ค่าจ้าง')
  })

  it('a Simplified Chinese string is byte-identical in and out', () => {
    const svc = new BundlesService(fixture())
    expect(svc.resolveKey('zh', 'glossary.payslip')).toBe('工资条')
  })
})
