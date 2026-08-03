import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Shell } from './Shell'
import { renderWithProviders, buildCurrentUser } from '../test/testUtils'
import { NAV_DESTINATIONS } from './navigation'

const BUNDLE = {
  'shell.nav.statutoryRules': 'Statutory rules',
  'shell.nav.audit': 'Audit trail',
  'shell.nav.documents': 'Documents',
  'shell.nav.roles': 'Roles',
  'shell.nav.notifications': 'Notifications',
}

describe('Shell navigation is role-driven', () => {
  it('renders only the destinations the caller has a permission for', () => {
    renderWithProviders(<Shell />, {
      i18n: { bundle: BUNDLE },
      auth: {
        currentUser: buildCurrentUser({ permissions: new Set(['config.rule.read', 'audit.read']) }),
      },
    })

    expect(screen.getByRole('link', { name: 'Statutory rules' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Audit trail' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Documents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Roles' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Notifications' })).not.toBeInTheDocument()
  })

  it('renders no nav destinations for a user with no permissions at all', () => {
    renderWithProviders(<Shell />, {
      i18n: { bundle: BUNDLE },
      auth: { currentUser: buildCurrentUser({ permissions: new Set() }) },
    })

    for (const destination of NAV_DESTINATIONS) {
      expect(screen.queryByText(BUNDLE[destination.labelKey as keyof typeof BUNDLE] ?? '')).not.toBeInTheDocument()
    }
  })

  it.each(['th', 'en', 'zh'] as const)('renders without crashing in locale "%s"', (locale) => {
    renderWithProviders(<Shell />, {
      i18n: { locale, bundle: BUNDLE },
      auth: { currentUser: buildCurrentUser({ permissions: new Set(['config.rule.read']) }) },
    })
    expect(screen.getByRole('link', { name: 'Statutory rules' })).toBeInTheDocument()
  })
})
