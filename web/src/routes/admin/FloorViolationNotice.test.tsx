import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { FloorViolationNotice } from './FloorViolationNotice'
import { renderWithProviders } from '../../test/testUtils'
import type { ApiErrorEnvelope } from '../../api/httpClient'

const BUNDLE = {
  'admin.statutoryRules.floorViolation.title': 'Below the statutory floor',
  'admin.statutoryRules.floorViolation.body': '{value} is below the statutory floor of {floor}.',
  'admin.statutoryRules.citationSeal.withFloor': '§ {citation} · floor {floor}',
}

/**
 * "When a proposal is rejected below the statutory floor, show the
 * citation and the floor. That single interaction is the product's entire
 * compliance argument made visible." (task brief) — this is that render,
 * for the exact `CFG-422` envelope `services/svc-config/src/rules.service.ts`'s
 * `statutoryFloorViolation` produces.
 */
describe('FloorViolationNotice', () => {
  it('renders the citation and the statutory floor on a below-floor rejection', () => {
    const envelope: ApiErrorEnvelope = {
      code: 'CFG-422',
      message_i18n_key: 'config.error.below_statutory_floor',
      details: [{ ruleKey: 'leave.annual.min_days', value: 4, statutoryFloor: 6, citation: 'LPA s.30' }],
    }

    renderWithProviders(<FloorViolationNotice envelope={envelope} />, { i18n: { bundle: BUNDLE } })

    expect(screen.getByText('Below the statutory floor')).toBeInTheDocument()
    expect(screen.getByText('4 is below the statutory floor of 6.')).toBeInTheDocument()
    expect(screen.getByText('§ LPA s.30 · floor 6')).toBeInTheDocument()
  })
})
