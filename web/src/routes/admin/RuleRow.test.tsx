import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { RuleRow } from './StatutoryRulesPage'
import { renderWithProviders, buildCurrentUser } from '../../test/testUtils'
import type { StatutoryRuleRow } from '../../api/svcConfig'

const BUNDLE = {
  'admin.statutoryRules.approve.cta': 'Approve',
  'admin.statutoryRules.approve.selfProposed':
    'You proposed this change — a different approver is required (segregation of duties).',
}

function draftRow(overrides: Partial<StatutoryRuleRow> = {}): StatutoryRuleRow {
  return {
    id: 'rule-1',
    ruleKey: 'leave.annual.min_days',
    value: 6,
    unit: 'days',
    statutoryFloor: 6,
    statutoryCeiling: null,
    citation: 'LPA s.30',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    governanceClass: 'STATUTORY_FLOOR',
    status: 'draft',
    proposedBy: 'user-proposer',
    approvedBy: null,
    reason: 'annual review',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * "Approve must be hidden or disabled for the user who proposed it —
 * segregation of duties, mirrored in the UI so a user never meets a 409
 * they could not have predicted." (task brief) — mirrors
 * `services/svc-config/src/rules.service.ts`'s `approve()`, which rejects
 * `row.proposedBy === approvedBy` with `AUZ-409` server-side.
 */
describe('RuleRow — segregation of duties', () => {
  it('hides the Approve button and shows the self-proposed notice for the row\'s own proposer', () => {
    renderWithProviders(<RuleRow row={draftRow({ proposedBy: 'user-1' })} onApproved={() => undefined} />, {
      i18n: { bundle: BUNDLE },
      auth: {
        currentUser: buildCurrentUser({ id: 'user-1', permissions: new Set(['config.rule.approve']) }),
      },
    })

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(
      screen.getByText('You proposed this change — a different approver is required (segregation of duties).'),
    ).toBeInTheDocument()
  })

  it('shows the Approve button to a different, permitted approver', () => {
    renderWithProviders(<RuleRow row={draftRow({ proposedBy: 'user-1' })} onApproved={() => undefined} />, {
      i18n: { bundle: BUNDLE },
      auth: {
        currentUser: buildCurrentUser({ id: 'user-2', permissions: new Set(['config.rule.approve']) }),
      },
    })

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('hides the Approve button entirely for a user without config.rule.approve, proposer or not', () => {
    renderWithProviders(<RuleRow row={draftRow({ proposedBy: 'user-1' })} onApproved={() => undefined} />, {
      i18n: { bundle: BUNDLE },
      auth: { currentUser: buildCurrentUser({ id: 'user-2', permissions: new Set() }) },
    })

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(
      screen.queryByText('You proposed this change — a different approver is required (segregation of duties).'),
    ).not.toBeInTheDocument()
  })
})
