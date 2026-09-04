import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Shell } from './Shell'
import { renderWithProviders, buildCurrentUser } from '../test/testUtils'
import { NAV_DESTINATIONS } from './navigation'

const BUNDLE = {
  'shell.nav.employees': 'Employees',
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
      const label = BUNDLE[destination.labelKey as keyof typeof BUNDLE]
      // A destination missing from this fixture used to fall through to
      // `?? ''`, and `queryByText('')` matches every empty node in the
      // tree — so adding a nav destination without adding its label here
      // failed with "found multiple elements" rather than "you forgot a
      // label". Assert the fixture is complete first.
      expect(label, `Shell.test.tsx BUNDLE is missing ${destination.labelKey}`).toBeTruthy()
      expect(screen.queryByText(label)).not.toBeInTheDocument()
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
