import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { RuleValue } from './RuleValue'
import { renderWithProviders } from '../../test/testUtils'

const BUNDLE = {
  'admin.statutoryRules.value.empty': 'None',
  'admin.statutoryRules.value.entries': '{count} entries',
  'admin.statutoryRules.value.fields': '{count} fields',
  'common.yes': 'Yes',
  'common.no': 'No',
}

/**
 * The regression these tests exist for: this screen rendered every value
 * with `String(value)`, so every rule whose value is not a scalar showed
 * the literal text `[object Object]` in production. That is not cosmetic —
 * the PIT brackets, the OT multiplier table and the 2026 holiday calendar
 * are exactly the figures a compliance reviewer opens this page to check,
 * and they were the ones destroyed. `holidays.public.2026` rendered as
 * twenty-six stacked `[object Object]`s.
 *
 * Every assertion below therefore also checks that string is ABSENT, not
 * merely that something sensible is present: a future change that renders
 * a summary correctly but leaks `[object Object]` into a nested field
 * would otherwise still pass.
 */
describe('RuleValue — no shape renders as [object Object]', () => {
  it('renders a number plainly', () => {
    renderWithProviders(<RuleValue value={8} />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('8')).toBeInTheDocument()
  })

  it('renders a string plainly', () => {
    renderWithProviders(<RuleValue value="30/26/actual" />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('30/26/actual')).toBeInTheDocument()
  })

  it('renders a boolean as translated Yes/No, not "true"', () => {
    renderWithProviders(<RuleValue value={true} />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('Yes')).toBeInTheDocument()
    expect(screen.queryByText('true')).not.toBeInTheDocument()
  })

  it('renders null as the translated empty marker', () => {
    renderWithProviders(<RuleValue value={null} />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('None')).toBeInTheDocument()
  })

  it('summarises an object by its field count and shows every field name and value', () => {
    renderWithProviders(<RuleValue value={{ minutes: 60, afterHours: 5 }} />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('2 fields')).toBeInTheDocument()
    expect(screen.getByText('minutes')).toBeInTheDocument()
    expect(screen.getByText('60')).toBeInTheDocument()
    expect(screen.getByText('afterHours')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
  })

  it('summarises an array by its length', () => {
    renderWithProviders(<RuleValue value={[1, 2, 3]} />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('3 entries')).toBeInTheDocument()
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
  })

  it('renders an array of objects — the holidays.public.2026 shape — with no [object Object] anywhere', () => {
    const holidays = [
      { date: '2026-01-01', name: 'New Year' },
      { date: '2026-05-01', name: 'National Labour Day' },
    ]

    renderWithProviders(<RuleValue value={holidays} />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('2 entries')).toBeInTheDocument()
    expect(screen.getByText('2026-05-01')).toBeInTheDocument()
    expect(screen.getByText('National Labour Day')).toBeInTheDocument()
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
  })

  it('recurses into nested structures without falling back to String()', () => {
    const nested = { brackets: [{ upTo: 150000, rate: 0 }] }

    renderWithProviders(<RuleValue value={nested} />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('brackets')).toBeInTheDocument()
    expect(screen.getByText('150000')).toBeInTheDocument()
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
  })

  it('renders an empty object as the empty marker rather than an empty disclosure', () => {
    renderWithProviders(<RuleValue value={{}} />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('None')).toBeInTheDocument()
    expect(screen.queryByText('0 fields')).not.toBeInTheDocument()
  })

  it('keeps structured values collapsed by default, so fifty rules stay scannable', () => {
    renderWithProviders(<RuleValue value={{ minutes: 60 }} />, { i18n: { bundle: BUNDLE } })

    const disclosure = document.querySelector('details')
    expect(disclosure).not.toBeNull()
    expect((disclosure as HTMLDetailsElement).open).toBe(false)
  })
})
