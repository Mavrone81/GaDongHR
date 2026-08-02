import 'reflect-metadata'
import { HttpException } from '@nestjs/common'
import { BundlesController } from './bundles.controller'
import { BundlesService } from './bundles.service'
import type { RawBundles } from './bundles.service'

function fixtureService(): BundlesService {
  const raw: RawBundles = {
    en: { leave: { request: { submit: 'Submit leave request' } }, common: { save: 'Save' } },
    th: { leave: { request: { submit: 'ส่งคำขอลา' } }, common: { save: 'บันทึก' } },
    zh: { leave: { request: {} }, common: { save: '保存' } }, // zh.leave.request.submit deliberately missing
  }
  return new BundlesService(raw, { warn: () => undefined })
}

describe('BundlesController', () => {
  describe('GET /bundles/:locale', () => {
    it.each(['th', 'en', 'zh'] as const)('returns the full resolved bundle for supported locale %s', (locale) => {
      const controller = new BundlesController(fixtureService())
      const bundle = controller.getBundle(locale)
      expect(bundle['common.save']).toBeDefined()
      expect(bundle['leave.request.submit']).toBeDefined()
    })

    it('applies namespace filtering via ?ns=', () => {
      const controller = new BundlesController(fixtureService())
      const bundle = controller.getBundle('en', 'leave')
      expect(Object.keys(bundle)).toEqual(['leave.request.submit'])
    })

    it.each(['fr', 'TH', 'th-TH', ''])('returns 404 for unsupported locale %j — never a fallback bundle', (locale) => {
      const controller = new BundlesController(fixtureService())
      expect(() => controller.getBundle(locale)).toThrow(HttpException)
      try {
        controller.getBundle(locale)
        throw new Error('expected throw')
      } catch (thrown) {
        expect(thrown).toBeInstanceOf(HttpException)
        const httpErr = thrown as HttpException
        expect(httpErr.getStatus()).toBe(404)
        expect(httpErr.getResponse()).toMatchObject({ code: 'I18N-404', details: [{ locale }] })
      }
    })
  })

  describe('GET /glossary', () => {
    it('returns a { terms } envelope', () => {
      const controller = new BundlesController(fixtureService())
      const out = controller.getGlossary()
      expect(Array.isArray(out.terms)).toBe(true)
    })
  })

  describe('GET /health', () => {
    it('reports ok status and per-locale missing-key counts', () => {
      const controller = new BundlesController(fixtureService())
      const out = controller.health()
      expect(out).toMatchObject({ status: 'ok', service: 'svc-i18n' })
      expect(out.missingKeys).toEqual({ th: 0, en: 0, zh: 1 })
    })
  })
})
