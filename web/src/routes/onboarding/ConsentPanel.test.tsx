import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConsentPanel } from './ConsentPanel'
import { renderWithProviders, buildCurrentUser } from '../../test/testUtils'
import * as svcOnboarding from '../../api/svcOnboarding'
import type { ConsentDecisionInput } from '../../api/svcOnboarding'

const BUNDLE = {
  'onboarding.consent.title': 'PDPA consent',
  'onboarding.consent.separateNote': 'Biometric consent is asked separately.',
  'onboarding.consent.grant': 'Give consent',
  'onboarding.consent.refuse': 'Refuse',
  'onboarding.consent.recordedGranted': 'Consent recorded.',
  'onboarding.consent.recordedRefused': 'Refusal recorded.',
  'onboarding.consent.hrProcessing.title': 'HR data processing',
  'onboarding.consent.hrProcessing.body': 'Consent to process personal data.',
  'onboarding.consent.biometric.title': 'Biometric data (face recognition)',
  'onboarding.consent.biometric.body': 'Consent to enrol a face template.',
}

function mockClient(submitConsent = vi.fn().mockResolvedValue({ records: [] })) {
  vi.spyOn(svcOnboarding, 'useSvcOnboarding').mockReturnValue({
    listEmployees: vi.fn().mockResolvedValue([]),
    getEmployee: vi.fn(),
    createEmployee: vi.fn(),
    submitConsent,
    getChecklist: vi.fn().mockResolvedValue([]),
    completeTask: vi.fn(),
  })
  return submitConsent
}

function render(permissions = new Set(['consent.self'])) {
  return renderWithProviders(<ConsentPanel employeeId="emp-1" onChanged={vi.fn()} />, {
    i18n: { bundle: BUNDLE },
    auth: { currentUser: buildCurrentUser({ permissions }) },
  })
}

/** The `.consent-section` block a given heading belongs to — each purpose owns its own buttons, which is the whole point of the separation. */
function sectionFor(title: string): HTMLElement {
  const section = screen.getByText(title).closest('.consent-section')
  if (!(section instanceof HTMLElement)) throw new Error(`no .consent-section found for "${title}"`)
  return section
}

/**
 * PDPA-BIOMETRIC-COMPLIANCE.md §4.1 and M1-ONBOARDING §1.1 require
 * biometric consent to be a SEPARATE submission from the general
 * HR-processing notice. svc-onboarding enforces it server-side (bundling
 * them is ONB-020, checked before anything else), but a UI that OFFERED
 * the combined shape would still be the dark pattern the rule exists to
 * prevent — the user would experience one decision covering both, and
 * only the server would know otherwise.
 *
 * These tests therefore assert the shape of what the UI sends, not merely
 * that it succeeds: one purpose per request, never an array, and never
 * both purposes in one call.
 */
describe('ConsentPanel — biometric consent is a separate act, and refusal is first-class', () => {
  it('submits HR processing as its own single-purpose decision', async () => {
    const submitConsent = mockClient()
    const user = userEvent.setup()
    render()

    const hrSection = sectionFor(BUNDLE['onboarding.consent.hrProcessing.title'])
    await user.click(within(hrSection).getByRole('button', { name: BUNDLE['onboarding.consent.grant'] }))

    await waitFor(() => expect(submitConsent).toHaveBeenCalledTimes(1))
    const [, input] = submitConsent.mock.calls[0] as [string, ConsentDecisionInput]
    expect(input.purpose).toBe('hr_processing')
    expect(Array.isArray(input.purpose)).toBe(false)
    expect(input.decision).toBe('granted')
  })

  it('submits biometric as its own single-purpose decision, never bundled with another', async () => {
    const submitConsent = mockClient()
    const user = userEvent.setup()
    render()

    const bioSection = sectionFor(BUNDLE['onboarding.consent.biometric.title'])
    await user.click(within(bioSection).getByRole('button', { name: BUNDLE['onboarding.consent.grant'] }))

    await waitFor(() => expect(submitConsent).toHaveBeenCalledTimes(1))
    const [, input] = submitConsent.mock.calls[0] as [string, ConsentDecisionInput]
    expect(input.purpose).toBe('biometric')
    expect(Array.isArray(input.purpose)).toBe(false)
  })

  it('records a refusal — UAT U2 requires a working refusal path, and PDPA requires it be as easy as agreeing', async () => {
    const submitConsent = mockClient()
    const user = userEvent.setup()
    render()

    const bioSection = sectionFor(BUNDLE['onboarding.consent.biometric.title'])
    await user.click(within(bioSection).getByRole('button', { name: BUNDLE['onboarding.consent.refuse'] }))

    await waitFor(() => expect(submitConsent).toHaveBeenCalledTimes(1))
    const [, input] = submitConsent.mock.calls[0] as [string, ConsentDecisionInput]
    expect(input).toMatchObject({ purpose: 'biometric', decision: 'refused' })
  })

  it('offers Refuse for every purpose it offers Grant for — refusal is never the absence of an action', () => {
    mockClient()
    render()

    expect(screen.getAllByRole('button', { name: BUNDLE['onboarding.consent.grant'] })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: BUNDLE['onboarding.consent.refuse'] })).toHaveLength(2)
  })

  it('records a form version with every decision, so a later change to the notice cannot be read as agreement to new wording', async () => {
    const submitConsent = mockClient()
    const user = userEvent.setup()
    render()

    await user.click(screen.getAllByRole('button', { name: BUNDLE['onboarding.consent.grant'] })[0] as HTMLElement)

    await waitFor(() => expect(submitConsent).toHaveBeenCalledTimes(1))
    const [, input] = submitConsent.mock.calls[0] as [string, ConsentDecisionInput]
    expect(typeof input.formVersion).toBe('number')
  })

  it('renders nothing for a caller without consent.self rather than offering a control the server would refuse', () => {
    mockClient()
    render(new Set())

    expect(screen.queryByText(BUNDLE['onboarding.consent.title'])).not.toBeInTheDocument()
  })
})
