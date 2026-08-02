import { GadongError } from '@gadong/kernel'
import { resolveMergeFields, substituteTemplate } from './merge-fields'
import type { MergeFields } from './merge-fields'

describe('resolveMergeFields — dates render Buddhist Era on th, Gregorian on en/zh (kernel formatDate, never reimplemented)', () => {
  const fields: MergeFields = { payDate: { type: 'date', iso: '2026-08-02' } }

  it('th renders 2569 (2026 + 543), not 2026', () => {
    expect(resolveMergeFields(fields, 'th')).toEqual({ payDate: '02/08/2569' })
  })

  it('en renders the Gregorian year unchanged', () => {
    expect(resolveMergeFields(fields, 'en')).toEqual({ payDate: '02/08/2026' })
  })

  it('zh renders the Gregorian year unchanged', () => {
    expect(resolveMergeFields(fields, 'zh')).toEqual({ payDate: '02/08/2026' })
  })
})

describe('resolveMergeFields — money via kernel formatTHB (bigint satang, never a float)', () => {
  it('formats satang as grouped Baht with a 2-digit satang remainder', () => {
    const fields: MergeFields = { grossPay: { type: 'money', satang: '3050000' } }
    expect(resolveMergeFields(fields, 'th')).toEqual({ grossPay: '฿30,500.00' })
  })
})

describe('resolveMergeFields — text fields are HTML-escaped', () => {
  it('escapes metacharacters so a name/company field cannot inject markup', () => {
    const fields: MergeFields = { employeeName: { type: 'text', value: '<script>alert(1)</script> & "quoted"' } }
    const resolved = resolveMergeFields(fields, 'en')
    expect(resolved['employeeName']).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;')
  })
})

describe('substituteTemplate', () => {
  it('replaces every {{token}} with its resolved value', () => {
    const html = '<p>{{greeting}}, {{name}}!</p>'
    const out = substituteTemplate(html, { greeting: 'Hello', name: 'Somchai' }, 'test-kind', 'en')
    expect(out).toBe('<p>Hello, Somchai!</p>')
  })

  it('throws DOC-422 when the template references a token with no resolved value — never ships a literal {{token}}', () => {
    const html = '<p>{{employeeName}} — {{missingField}}</p>'
    expect(() => substituteTemplate(html, { employeeName: 'Somchai' }, 'payslip', 'en')).toThrow(GadongError)
    try {
      substituteTemplate(html, { employeeName: 'Somchai' }, 'payslip', 'en')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(GadongError)
      const gadongErr = err as GadongError
      expect(gadongErr.code).toBe('DOC-422')
      expect(gadongErr.details).toEqual([{ kind: 'payslip', lang: 'en', fields: ['missingField'] }])
    }
  })
})
