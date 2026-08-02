import { join } from 'node:path'
import { GadongError } from '@gadong/kernel'
import { TemplateLoader } from './templates'

const TEMPLATES_DIR = join(__dirname, '..', 'templates')

describe('TemplateLoader — resolves the real templates/ this service ships', () => {
  it('loads payslip.th.html directly when it exists — no fallback, no warning', () => {
    const loader = new TemplateLoader(TEMPLATES_DIR)
    const warn = jest.fn()
    const result = loader.resolve('payslip', 'th', { warn })

    expect(result.fellBack).toBe(false)
    expect(result.lang).toBe('th')
    expect(result.html).toContain('สลิปเงินเดือน')
    expect(warn).not.toHaveBeenCalled()
  })

  it('loads payslip.zh.html directly when it exists', () => {
    const loader = new TemplateLoader(TEMPLATES_DIR)
    const result = loader.resolve('payslip', 'zh', { warn: jest.fn() })
    expect(result.fellBack).toBe(false)
    expect(result.html).toContain('工资条')
  })

  it('falls back to contract.en.html and logs a warning when contract.zh.html does not exist', () => {
    const loader = new TemplateLoader(TEMPLATES_DIR)
    const warn = jest.fn()
    const result = loader.resolve('contract', 'zh', { warn })

    expect(result.fellBack).toBe(true)
    expect(result.lang).toBe('en')
    expect(result.html).toContain('Employment Contract')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/kind="contract".*lang="zh".*falling back to "en"/)
  })

  it('throws DOC-404 when neither the requested language nor the en fallback exists for an unknown kind', () => {
    const loader = new TemplateLoader(TEMPLATES_DIR)
    expect(() => loader.resolve('nonexistent-kind', 'th', { warn: jest.fn() })).toThrow(GadongError)
    try {
      loader.resolve('nonexistent-kind', 'th', { warn: jest.fn() })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(GadongError)
      expect((err as GadongError).code).toBe('DOC-404')
    }
  })
})
