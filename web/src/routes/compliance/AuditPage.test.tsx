import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { AuditEntryLine, VerifyPanel } from './AuditPage'
import { renderWithProviders } from '../../test/testUtils'
import type { AuditEntryRow } from '../../api/svcAudit'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const BUNDLE = {
  'common.view': 'View',
  'audit.detailPanel.prevEntryHash': 'Previous entry hash',
  'audit.detailPanel.entryHash': 'Entry hash',
  'audit.detailPanel.beforeHash': 'Before hash',
  'audit.detailPanel.afterHash': 'After hash',
  'audit.detailPanel.none': 'None recorded',
  'audit.table.actorLine': '{actorId} · {actorRole}',
  'audit.table.entityLine': '{entity} · {entityId}',
  'audit.verify.cta': 'Verify chain',
  'audit.verify.verifying': 'Verifying…',
  'audit.verify.valid': 'Chain intact — {count} entries checked, no issues found.',
  'audit.verify.invalid': '{issueCount} issue(s) found across {entryCount} entries.',
  'audit.verify.issueKind.content_mismatch': 'Content mismatch',
  'audit.verify.issueKind.chain_break': 'Chain break',
  'audit.verify.issueEntry': '{kind} — {entryId}',
}

function entryFixture(overrides: Partial<AuditEntryRow> = {}): AuditEntryRow {
  return {
    id: 'entry-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    actorId: 'user-1',
    actorRole: 'hr-officer',
    action: 'employee.update',
    entity: 'employee',
    entityId: 'emp-1',
    purpose: 'onboarding review',
    beforeHash: 'before-hash',
    afterHash: 'after-hash',
    prevEntryHash: 'prev-hash-abc',
    entryHash: 'entry-hash-def',
    ...overrides,
  }
}

/**
 * `AuditEntryLine` renders the hash-chain fields already present in the
 * list response (`services/svc-audit/src/entries.controller.ts`'s
 * `GET /entries` — no separate detail fetch exists), and reveals them only
 * on demand, matching `RuleRow.tsx`'s "View" toggle pattern.
 */
describe('AuditEntryLine', () => {
  it('renders the row summary but not the hash-chain detail until View is clicked', () => {
    renderWithProviders(
      <table>
        <tbody>
          <AuditEntryLine entry={entryFixture()} />
        </tbody>
      </table>,
      { i18n: { bundle: BUNDLE } },
    )

    expect(screen.getByText('employee.update')).toBeInTheDocument()
    expect(screen.queryByText('entry-hash-def')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'View' }))

    expect(screen.getByText('entry-hash-def')).toBeInTheDocument()
    expect(screen.getByText('prev-hash-abc')).toBeInTheDocument()
    expect(screen.getByText('before-hash')).toBeInTheDocument()
    expect(screen.getByText('after-hash')).toBeInTheDocument()
  })

  it('falls back to "None recorded" for a genesis-shaped entry with no before/after hash', () => {
    renderWithProviders(
      <table>
        <tbody>
          <AuditEntryLine entry={entryFixture({ beforeHash: null, afterHash: null })} />
        </tbody>
      </table>,
      { i18n: { bundle: BUNDLE } },
    )

    fireEvent.click(screen.getByRole('button', { name: 'View' }))

    expect(screen.getAllByText('None recorded')).toHaveLength(2)
  })
})

/**
 * `VerifyPanel` — the chain-integrity affordance (`GET /verify`). Both the
 * "intact" and "issues found" shapes `VerifyResult` can take are exercised
 * against a stubbed `fetch`, matching `svcI18n.test.tsx`'s established
 * pattern for testing a hook-driven network call without a live backend.
 */
describe('VerifyPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports an intact chain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { valid: true, entryCount: 3, issues: [] })))

    renderWithProviders(<VerifyPanel />, { i18n: { bundle: BUNDLE } })

    fireEvent.click(screen.getByRole('button', { name: 'Verify chain' }))

    expect(await screen.findByText('Chain intact — 3 entries checked, no issues found.')).toBeInTheDocument()
  })

  it('names the specific entry and kind for a broken chain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          valid: false,
          entryCount: 5,
          issues: [{ entryId: '3', kind: 'chain_break', message: 'entry 3: prev_entry_hash does not match' }],
        }),
      ),
    )

    renderWithProviders(<VerifyPanel />, { i18n: { bundle: BUNDLE } })

    fireEvent.click(screen.getByRole('button', { name: 'Verify chain' }))

    expect(await screen.findByText('1 issue(s) found across 5 entries.')).toBeInTheDocument()
    const issue = screen.getByText((_, el) => el?.tagName === 'STRONG' && el.textContent === 'Chain break — 3')
    expect(issue).toBeInTheDocument()
    expect(screen.getByText('entry 3: prev_entry_hash does not match')).toBeInTheDocument()
  })
})
