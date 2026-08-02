import { join } from 'node:path'
import { BundlesService } from './bundles.service'
import { loadRawBundles } from './bundle-loader'

/**
 * The release gate (Task 10 brief: "Parity: every key in `en` exists in
 * `th` and `zh`. ... it must fail loudly and NAME the missing keys, not
 * just report a count"). `missingKeys()` returns the offending keys
 * themselves, so a failing `toEqual([])` prints the exact list in the
 * jest diff — nobody has to go dig a count out of `/health` to find out
 * *which* string a translator still owes.
 *
 * This loads the real files at `services/svc-i18n/bundles/*.json`, not a
 * fixture — it is the actual content that ships that is under test here.
 */
const BUNDLES_DIR = join(__dirname, '..', 'bundles')

function realBundlesService(): BundlesService {
  return new BundlesService(loadRawBundles(BUNDLES_DIR), { warn: () => undefined })
}

describe('bundle parity — release gate', () => {
  it('every key present in en is present in th (lists any that are not)', () => {
    const svc = realBundlesService()
    expect(svc.missingKeys('th')).toEqual([])
  })

  it('every key present in en is present in zh (lists any that are not)', () => {
    const svc = realBundlesService()
    expect(svc.missingKeys('zh')).toEqual([])
  })

  it('reports zero missing keys for every locale via the same counts /health exposes', () => {
    const svc = realBundlesService()
    expect(svc.getMissingKeyCounts()).toEqual({ th: 0, en: 0, zh: 0 })
  })
})

describe('seed content — required namespaces and glossary (I18N-GUIDE.md §2)', () => {
  const svc = realBundlesService()
  const enKeys = Object.keys(svc.getBundle('en'))

  it.each(['common', 'auth', 'leave', 'claims', 'payroll', 'attendance', 'onboarding'])(
    'namespace "%s" has at least one seeded key',
    (ns) => {
      expect(enKeys.some((k) => k.startsWith(`${ns}.`))).toBe(true)
    },
  )

  const GLOSSARY_TERMS = [
    'employee',
    'employer',
    'probation',
    'onboarding',
    'shift',
    'roster',
    'attendance',
    'timesheet',
    'overtime',
    'public_holiday',
    'weekly_rest_day',
    'annual_leave',
    'sick_leave',
    'personal_leave',
    'maternity_leave',
    'paternity_leave',
    'infant_care_leave',
    'leave_balance',
    'expense_claim',
    'per_diem',
    'payroll',
    'salary',
    'payslip',
    'deduction',
    'withholding_tax',
    'social_security_fund',
    'employee_welfare_fund',
    'provident_fund',
    'severance_pay',
    'pay_in_lieu_of_notice',
    'consent',
    'personal_data',
    'facial_recognition',
  ]

  it(`every glossary term from I18N-GUIDE.md §2 is seeded (${GLOSSARY_TERMS.length} terms)`, () => {
    const glossaryKeys = svc.getGlossary().map((t) => t.key)
    expect(glossaryKeys.sort()).toEqual([...GLOSSARY_TERMS].sort())
  })

  it('glossary values match the exact th/zh terms from I18N-GUIDE.md §2 (not retranslated)', () => {
    const terms = svc.getGlossary()
    const byKey = new Map(terms.map((t) => [t.key, t]))
    expect(byKey.get('salary')).toEqual({ key: 'salary', en: 'Salary / wage', th: 'เงินเดือน / ค่าจ้าง', zh: '工资' })
    expect(byKey.get('payslip')).toEqual({ key: 'payslip', en: 'Payslip', th: 'สลิปเงินเดือน', zh: '工资条' })
    expect(byKey.get('social_security_fund')).toEqual({
      key: 'social_security_fund',
      en: 'Social Security Fund',
      th: 'กองทุนประกันสังคม',
      zh: '社会保险基金',
    })
    expect(byKey.get('facial_recognition')).toEqual({
      key: 'facial_recognition',
      en: 'Facial recognition',
      th: 'การจดจำใบหน้า',
      zh: '人脸识别',
    })
  })
})

describe('statutory form names — NOT translated (I18N-GUIDE.md §2 footnote)', () => {
  const svc = realBundlesService()
  const STATUTORY_KEYS = ['statutory.form.sps_1_10', 'statutory.form.por_ngor_dor_1', 'statutory.form.fifty_tavi', 'statutory.form.kor_11']
  const EXPECTED = {
    'statutory.form.sps_1_10': 'สปส.1-10',
    'statutory.form.por_ngor_dor_1': 'ภ.ง.ด.1',
    'statutory.form.fifty_tavi': '50 ทวิ',
    'statutory.form.kor_11': 'กร.11',
  }

  it.each(STATUTORY_KEYS)('%s is byte-identical across th, en and zh bundles', (key) => {
    const th = svc.resolveKey('th', key)
    const en = svc.resolveKey('en', key)
    const zh = svc.resolveKey('zh', key)
    expect(th).toBe(en)
    expect(en).toBe(zh)
    expect(th).toBe(EXPECTED[key as keyof typeof EXPECTED])
  })
})
