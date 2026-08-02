import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateRenderer, substitute } from './templates'
import type { Logger } from './templates'

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'svc-notify-templates-'))
}

function writeTemplate(dir: string, kind: string, lang: string, subject: string, body: string): void {
  writeFileSync(join(dir, `${kind}.${lang}.json`), JSON.stringify({ subject, body }))
}

function fakeLogger(): { logger: Logger; warnings: Array<{ message: string; meta?: Record<string, unknown> }> } {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
  return { logger: { warn: (message, meta) => warnings.push({ message, meta }) }, warnings }
}

describe('substitute', () => {
  it('replaces every {{placeholder}} with the matching var', () => {
    expect(substitute('Hello {{name}}, you have {{count}} items', { name: 'Somchai', count: '3' })).toBe(
      'Hello Somchai, you have 3 items',
    )
  })

  it('leaves a placeholder with no matching var as literal text rather than dropping it silently', () => {
    expect(substitute('Hello {{name}}', {})).toBe('Hello {{name}}')
  })
})

describe('TemplateRenderer.load — happy path', () => {
  it('loads the template for the requested language when it exists', () => {
    const dir = fixtureDir()
    writeTemplate(dir, 'leave.approved', 'th', 'TH subject', 'TH body')
    writeTemplate(dir, 'leave.approved', 'en', 'EN subject', 'EN body')
    const { logger, warnings } = fakeLogger()
    const renderer = new TemplateRenderer(logger, dir)

    const { template, effectiveLang } = renderer.load('leave.approved', 'th')

    expect(template).toEqual({ subject: 'TH subject', body: 'TH body' })
    expect(effectiveLang).toBe('th')
    expect(warnings).toHaveLength(0)
  })
})

describe('TemplateRenderer.load — missing-language fallback', () => {
  it('falls back to English and logs a warning naming the template and language when the recipient language is missing', () => {
    const dir = fixtureDir()
    writeTemplate(dir, 'leave.approved', 'en', 'EN subject', 'EN body')
    // Deliberately no `.zh.json` for this kind.
    const { logger, warnings } = fakeLogger()
    const renderer = new TemplateRenderer(logger, dir)

    const { template, effectiveLang } = renderer.load('leave.approved', 'zh')

    expect(template).toEqual({ subject: 'EN subject', body: 'EN body' })
    expect(effectiveLang).toBe('en')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.meta).toMatchObject({ kind: 'leave.approved', lang: 'zh' })
  })

  it('throws when even the English fallback is missing', () => {
    const dir = fixtureDir()
    const renderer = new TemplateRenderer(fakeLogger().logger, dir)

    expect(() => renderer.load('does.not.exist', 'th')).toThrow(/no template found/)
  })
})

describe('TemplateRenderer.render', () => {
  it('substitutes vars into both subject and body', () => {
    const renderer = new TemplateRenderer()
    const rendered = renderer.render({ subject: 'Hi {{name}}', body: 'You have {{days}} days' }, { name: 'Somchai', days: '3' })
    expect(rendered).toEqual({ subject: 'Hi Somchai', body: 'You have 3 days' })
  })
})
