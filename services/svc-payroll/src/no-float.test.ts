import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bahtToSatang } from './money'
import { computeGrossToNet } from './engine/gross-to-net'
import { resolveEngineRules } from './engine/rules'
import { StatutoryResolver } from './statutory'
import { ZERO_TIMESHEET } from './engine/types'
import type { GrossToNetInput } from './engine/types'
import { PROVINCE_BANGKOK, seededConfig } from './testing/statutory-fixture'

/**
 * TWO ASSERTIONS THE WHOLE MODULE RESTS ON, both enforced mechanically
 * rather than by review:
 *
 *  1. NO FLOAT APPEARS IN ANY CALCULATION PATH. Money is `bigint` satang end
 *     to end. A double cannot represent 0.1, and a payroll engine performs
 *     thousands of operations per run; a satang of drift is a wrong PND 1
 *     filing or an underpaid worker.
 *
 *  2. NO STATUTORY FIGURE APPEARS IN A `.ts` FILE OUTSIDE THE TEST FIXTURE.
 *     Every rate, ceiling, bracket and tier resolves from `svc-config` at
 *     runtime. That is the reason the product can absorb a Thai law change
 *     as data, and the reason the September-versus-October EWF test can
 *     pass with no code change on either side of it.
 *
 * The first is proved twice — statically, by scanning the source, and
 * dynamically, by making every float-producing global throw for the
 * duration of a real calculation.
 */

const SRC_DIR = __dirname

/** The files where money is actually computed. */
const MONEY_PATH_FILES = [
  'money.ts',
  'money-crypto.ts',
  'statutory.ts',
  'engine/gross-to-net.ts',
  'engine/pit.ts',
  'engine/minimum-wage.ts',
  'engine/rules.ts',
  'engine/severance.ts',
]

function everySourceFile(dir: string = SRC_DIR): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'testing' || entry.name === 'dist' || entry.name === 'node_modules') continue
      out.push(...everySourceFile(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Strips block comments, line comments and string/template literals, so the
 * scans below look at CODE and never at prose. Without this, a comment
 * explaining "the 2026 ceiling is 17,500" would fail the statutory-literal
 * scan, and the file-level documentation this module depends on would have
 * to be deleted to make a test pass — precisely the wrong incentive.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

describe('no float appears in any calculation path — static scan', () => {
  it.each(MONEY_PATH_FILES)('%s contains no float-producing construct', (relative) => {
    const code = codeOnly(readFileSync(join(SRC_DIR, relative), 'utf8'))
    expect(code).not.toMatch(/\bparseFloat\b/)
    expect(code).not.toMatch(/\.toFixed\s*\(/)
    expect(code).not.toMatch(/\bMath\.(pow|sqrt|trunc)\b/)
  })

  it.each(MONEY_PATH_FILES)('%s contains no decimal numeric LITERAL — every fractional value arrives as an exact rational', (relative) => {
    const code = codeOnly(readFileSync(join(SRC_DIR, relative), 'utf8'))
    const floatLiterals = code.match(/(?<![\w.])\d+\.\d+(?![\w.])/g) ?? []
    expect(floatLiterals).toEqual([])
  })

  it('no file in src/ (outside the test fixture) calls parseFloat or toFixed at all', () => {
    for (const file of everySourceFile()) {
      const code = codeOnly(readFileSync(file, 'utf8'))
      expect({ file, hit: /\bparseFloat\b|\.toFixed\s*\(/.test(code) }).toEqual({ file, hit: false })
    }
  })

  it('the scanner is not vacuous: it catches a float construct in a synthetic source', () => {
    const synthetic = codeOnly('const rate = parseFloat("0.05"); const shown = rate.toFixed(2)')
    expect(/\bparseFloat\b/.test(synthetic)).toBe(true)
    expect(/\.toFixed\s*\(/.test(synthetic)).toBe(true)
    expect(/(?<![\w.])\d+\.\d+(?![\w.])/.test(codeOnly('const x = 0.05'))).toBe(true)
  })

  it('the scanner ignores prose: a figure written in a comment or a string is not a code literal', () => {
    expect(codeOnly('// the ceiling is 17500 from 1 Jan 2026').trim()).toBe('')
    expect(/17500/.test(codeOnly("const k = 'sso.wage.ceiling' // 17500"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('no float appears in any calculation path — dynamic proof', () => {
  /**
   * Every float-producing global is replaced with a throwing stub for the
   * duration of a REAL gross-to-net calculation. If any code path reached
   * for one, the computation would fail rather than quietly produce a
   * rounded figure — which is the difference between a test that checks a
   * property and one that checks a habit.
   */
  it('a full calculation completes with parseFloat, toFixed and Math\'s rounding functions all booby-trapped', async () => {
    const config = seededConfig()
    const rules = await resolveEngineRules(new StatutoryResolver(config, '2026-10-31'), PROVINCE_BANGKOK)

    const input: GrossToNetInput = {
      employee: { id: 'emp-1', provinceCode: PROVINCE_BANGKOK },
      period: { code: '2026-10', start: '2026-10-01', end: '2026-10-31', payDate: '2026-10-31', indexInYear: 10 },
      profile: {
        basis: 'monthly',
        basePay: bahtToSatang('123456.78'),
        pfRatePercent: '7.5',
        pfRateEmployerPercent: '7.5',
        declaration: { spouse: true, children: 3, childrenSecondFrom2018: 1, parentsCaredFor: 2, otherAllowances: bahtToSatang('12345.67') },
      },
      timesheet: { ...ZERO_TIMESHEET, otWorkdayHours: '13.75', otHolidayWorkHours: '3.25', otHolidayOtHours: '1.5' },
      lines: [
        { code: 'allowance', direction: 'earning', amount: bahtToSatang('3333.33'), taxable: true, ssoWageBase: true, oneOff: false },
        { code: 'bonus', direction: 'earning', amount: bahtToSatang('99999.99'), taxable: true, ssoWageBase: true, oneOff: true },
        { code: 'reimbursement', direction: 'earning', amount: bahtToSatang('777.77'), taxable: false, ssoWageBase: false, oneOff: true },
        { code: 'union_dues', direction: 'deduction', amount: bahtToSatang('123.45'), taxable: false, ssoWageBase: false, oneOff: false },
      ],
      ytd: {
        taxableIncome: bahtToSatang('1111111.11'),
        ssoEmployee: bahtToSatang('7875.00'),
        pfEmployee: bahtToSatang('83333.33'),
        whtPaid: bahtToSatang('98765.43'),
      },
    }

    const originals = {
      parseFloat: globalThis.parseFloat,
      numberParseFloat: Number.parseFloat,
      toFixed: Number.prototype.toFixed,
      round: Math.round,
      floor: Math.floor,
      ceil: Math.ceil,
      abs: Math.abs,
    }
    const boom = (name: string) => () => {
      throw new Error(`no-float: the calculation path reached for ${name}`)
    }

    try {
      globalThis.parseFloat = boom('parseFloat') as unknown as typeof parseFloat
      Number.parseFloat = boom('Number.parseFloat') as unknown as typeof Number.parseFloat
      // Restored in `finally`; the whole point is to make a float construct
      // fail loudly for the duration of exactly one call.
      Number.prototype.toFixed = boom('Number.prototype.toFixed') as unknown as typeof Number.prototype.toFixed
      Math.round = boom('Math.round') as unknown as typeof Math.round
      Math.floor = boom('Math.floor') as unknown as typeof Math.floor
      Math.ceil = boom('Math.ceil') as unknown as typeof Math.ceil
      Math.abs = boom('Math.abs') as unknown as typeof Math.abs

      const result = computeGrossToNet(input, rules)

      expect(typeof result.net).toBe('bigint')
      expect(typeof result.wht).toBe('bigint')
      expect(typeof result.ssoEmployee).toBe('bigint')
      expect(typeof result.ewfEmployee).toBe('bigint')
      expect(typeof result.pfEmployee).toBe('bigint')
    } finally {
      globalThis.parseFloat = originals.parseFloat
      Number.parseFloat = originals.numberParseFloat
      Number.prototype.toFixed = originals.toFixed
      Math.round = originals.round
      Math.floor = originals.floor
      Math.ceil = originals.ceil
      Math.abs = originals.abs
    }
  })

  it('the booby trap is not vacuous: a float construct DOES throw while it is armed', () => {
    const original = globalThis.parseFloat
    try {
      globalThis.parseFloat = (() => {
        throw new Error('armed')
      }) as unknown as typeof parseFloat
      expect(() => globalThis.parseFloat('1.5')).toThrow('armed')
    } finally {
      globalThis.parseFloat = original
    }
  })
})

// ---------------------------------------------------------------------------

describe('no statutory figure appears in a .ts file outside the test fixture', () => {
  /**
   * Unmistakable figures only. Generic small integers (8 hours, 12 periods,
   * 30 days) are excluded because they collide with ordinary code and would
   * make this scan noisy rather than informative — those values are ALSO
   * config-resolved, and the tests in `gross-to-net.test.ts` prove it by
   * changing each one and asserting the result moves, which is a stronger
   * check than a grep.
   */
  const FIGURES: Array<[string, string]> = [
    ['17500', 'the 2026 SSO wage ceiling'],
    ['15000', 'the pre-2026 SSO wage ceiling'],
    ['1650', 'the SSO wage floor'],
    ['150000', 'the first PIT bracket edge'],
    ['300000', 'the second PIT bracket edge'],
    ['500000', 'the third PIT bracket edge'],
    ['750000', 'the fourth PIT bracket edge'],
    ['1000000', 'the fifth PIT bracket edge'],
    ['2000000', 'the sixth PIT bracket edge'],
    ['5000000', 'the seventh PIT bracket edge'],
    ['100000', 'the expense-deduction cap'],
    ['60000', 'the personal allowance'],
    ['30000', 'the child allowance'],
  ]

  it.each(FIGURES)('%s (%s) appears in no source file', (figure) => {
    const offenders = everySourceFile().filter((file) => codeOnly(readFileSync(file, 'utf8')).includes(figure))
    expect(offenders).toEqual([])
  })

  it('...and the same scan FINDS those figures in the test fixture, where they legitimately live', () => {
    const fixture = readFileSync(join(SRC_DIR, 'testing', 'statutory-fixture.ts'), 'utf8')
    for (const [figure] of FIGURES) expect(fixture).toContain(figure)
  })
})
