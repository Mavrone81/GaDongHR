import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { DocumentsPage } from './DocumentsPage'
import { renderWithProviders, buildCurrentUser } from '../../test/testUtils'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const BUNDLE = {
  'shell.brand': 'GaDongHR',
  'documents.title': 'Documents',
  'documents.lookup.title': 'Look up a document',
  'documents.lookup.id': 'Document ID',
  'documents.lookup.purpose': 'Purpose of this read',
  'documents.lookup.purposeHint': "Recorded against this document's decrypt for the PDPA access trail.",
  'documents.lookup.submit': 'Retrieve',
  'documents.meta.kind': 'Kind',
  'documents.meta.entityType': 'Entity type',
  'documents.meta.entityId': 'Entity ID',
  'documents.meta.lang': 'Language',
  'documents.meta.sha256': 'SHA-256',
  'documents.meta.createdAt': 'Created at',
  'documents.download.cta': 'Download PDF',
  'documents.generate.cta': 'Generate a document',
  'documents.generate.title': 'Generate a document',
  'documents.generate.kind': 'Kind',
  'documents.generate.lang': 'Language',
  'documents.generate.entityType': 'Entity type',
  'documents.generate.entityId': 'Entity ID',
  'documents.generate.html': 'Document HTML',
  'documents.generate.submit': 'Generate',
  'documents.generate.success': 'Document generated — id {id}.',
  'documents.generate.lookupNow': 'Look up this document',
  'docs.error.document_not_found': 'Document not found.',
  'common.loading': 'Loading…',
  'shell.locale.th': 'ไทย',
  'shell.locale.en': 'English',
  'shell.locale.zh': '中文',
}

const DOC_META = {
  id: 'doc-1',
  kind: 'contract',
  entityType: 'employee',
  entityId: 'emp-1',
  lang: 'en',
  sha256: 'abc123',
  createdAt: '2026-01-01T00:00:00.000Z',
  contentBase64: btoa('%PDF-1.4 fake pdf bytes'),
}

describe('DocumentsPage — lookup flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retrieves and renders a document by id, and offers a download', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, DOC_META)))

    renderWithProviders(<DocumentsPage />, { i18n: { bundle: BUNDLE }, route: '/documents' })

    fireEvent.change(screen.getByLabelText('Document ID'), { target: { value: 'doc-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve' }))

    expect(await screen.findByText('contract')).toBeInTheDocument()
    expect(screen.getByText('abc123')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument()
  })

  it('pre-fills the document id from the ?id= query string', () => {
    renderWithProviders(<DocumentsPage />, { i18n: { bundle: BUNDLE }, route: '/documents?id=doc-from-link' })

    expect(screen.getByLabelText('Document ID')).toHaveValue('doc-from-link')
  })

  it('shows the translated error for a document that does not exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(404, { code: 'DOC-404', message_i18n_key: 'docs.error.document_not_found', details: [{ id: 'missing' }] }),
      ),
    )

    renderWithProviders(<DocumentsPage />, { i18n: { bundle: BUNDLE }, route: '/documents' })

    fireEvent.change(screen.getByLabelText('Document ID'), { target: { value: 'missing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve' }))

    expect(await screen.findByText('Document not found.')).toBeInTheDocument()
  })
})

/**
 * `POST /render` is guarded by `document.generate` — a DIFFERENT permission
 * than the route's own `document.read` — so the generate panel is gated
 * independently, the same pattern `StatutoryRulesPage.tsx`'s Propose button
 * uses for `config.rule.propose` inside a page reachable on
 * `config.rule.read`.
 */
describe('DocumentsPage — generate panel permission gating', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is hidden for a caller without document.generate', () => {
    renderWithProviders(<DocumentsPage />, {
      i18n: { bundle: BUNDLE },
      route: '/documents',
      auth: { currentUser: buildCurrentUser({ permissions: new Set(['document.read']) }) },
    })

    expect(screen.queryByText('Generate a document')).not.toBeInTheDocument()
  })

  it('is shown, and generating offers an immediate look-up, for a caller who holds document.generate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, { id: 'doc-new', kind: 'letter', entityType: 'employee', entityId: 'emp-1', lang: 'en', sha256: 'sha-new' }),
      ),
    )

    renderWithProviders(<DocumentsPage />, {
      i18n: { bundle: BUNDLE },
      route: '/documents',
      auth: { currentUser: buildCurrentUser({ permissions: new Set(['document.read', 'document.generate']) }) },
    })

    fireEvent.change(screen.getByLabelText('Document HTML'), { target: { value: '<p>hello</p>' } })

    // `Kind`/`Entity type`/`Entity ID` label text is shared with the
    // lookup panel's read-only meta `Field`s above — those have no
    // `htmlFor` and wrap plain text, not a form control, so `getByLabelText`
    // resolves each to the ONE genuine `<label for>` input the generate
    // form declares (`documents-generate-*`), not an ambiguous match.
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'letter' } })
    fireEvent.change(screen.getByLabelText('Entity type'), { target: { value: 'employee' } })
    fireEvent.change(screen.getByLabelText('Entity ID'), { target: { value: 'emp-1' } })

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

    expect(await screen.findByText('Document generated — id doc-new.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Look up this document' })).toBeInTheDocument()
  })
})
