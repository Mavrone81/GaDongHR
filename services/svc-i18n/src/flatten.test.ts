import { flattenBundle } from './flatten'

describe('flattenBundle', () => {
  it('flattens nested objects into dotted keys', () => {
    const out = flattenBundle({ leave: { request: { submit: 'Submit leave request' } } })
    expect(out).toEqual({ 'leave.request.submit': 'Submit leave request' })
  })

  it('flattens multiple sibling branches independently', () => {
    const out = flattenBundle({ a: { x: '1', y: '2' }, b: '3' })
    expect(out).toEqual({ 'a.x': '1', 'a.y': '2', b: '3' })
  })

  it('preserves Thai combining-mark strings byte-identical', () => {
    const out = flattenBundle({ payroll: { payslip: { salary: 'เงินเดือน / ค่าจ้าง' } } })
    expect(out['payroll.payslip.salary']).toBe('เงินเดือน / ค่าจ้าง')
  })

  it('preserves Simplified Chinese strings byte-identical', () => {
    const out = flattenBundle({ payroll: { payslip: { title: '工资条' } } })
    expect(out['payroll.payslip.title']).toBe('工资条')
  })

  it('throws naming the exact path when a leaf is not a string', () => {
    expect(() => flattenBundle({ leave: { request: { submit: 42 } } })).toThrow(/"leave\.request\.submit"/)
  })

  it('throws naming the exact path when a leaf is an array', () => {
    expect(() => flattenBundle({ leave: { types: ['annual', 'sick'] } })).toThrow(/"leave\.types"/)
  })

  it('throws naming the exact path when a leaf is null', () => {
    expect(() => flattenBundle({ leave: { request: { submit: null } } })).toThrow(/"leave\.request\.submit"/)
  })

  it('throws when the root itself is not an object', () => {
    expect(() => flattenBundle('not an object')).toThrow(/\(root\)/)
  })
})
