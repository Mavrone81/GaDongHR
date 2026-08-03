import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { DateText } from './DateText'
import { renderWithProviders } from '../test/testUtils'

/**
 * "A Thai date shows พ.ศ. 2569 for 2026, English and Chinese show 2026"
 * (task brief) — proves this app renders dates via `@gadong/kernel`'s
 * `formatDate` (Buddhist Era offset), not a reimplementation.
 */
describe('DateText renders per-locale via the kernel formatter', () => {
  it('renders the Buddhist Era year (พ.ศ. 2569) for 2026-08-02 in Thai', () => {
    renderWithProviders(<DateText iso="2026-08-02" />, { i18n: { locale: 'th' } })
    expect(screen.getByText('02/08/2569')).toBeInTheDocument()
  })

  it('renders the Gregorian year (2026) for 2026-08-02 in English', () => {
    renderWithProviders(<DateText iso="2026-08-02" />, { i18n: { locale: 'en' } })
    expect(screen.getByText('02/08/2026')).toBeInTheDocument()
  })

  it('renders the Gregorian year (2026) for 2026-08-02 in Chinese', () => {
    renderWithProviders(<DateText iso="2026-08-02" />, { i18n: { locale: 'zh' } })
    expect(screen.getByText('02/08/2026')).toBeInTheDocument()
  })
})
