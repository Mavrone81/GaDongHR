import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { NotificationsPage } from './NotificationsPage'
import { renderWithProviders, buildCurrentUser } from '../../test/testUtils'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const BUNDLE = {
  'shell.brand': 'GaDongHR',
  'notifications.title': 'Notifications',
  'notifications.filter.all': 'All',
  'notifications.filter.unreadOnly': 'Unread only',
  'notifications.emptyState': 'No notifications.',
  'notifications.unreadBadge': 'Unread',
  'notifications.markRead.cta': 'Mark read',
  'common.loading': 'Loading…',
}

const UNREAD_NOTIFICATION = {
  id: 'notif-1',
  recipientUserId: 'user-1',
  kind: 'leave.approved',
  lang: 'en',
  subject: 'Your leave request was approved',
  body: 'Your annual leave for 2026-02-01 was approved.',
  readAt: null,
  createdAt: '2026-01-15T00:00:00.000Z',
}

describe('NotificationsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders notifications with an unread badge and a Mark read control for a caller who can update them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { notifications: [UNREAD_NOTIFICATION] })))

    renderWithProviders(<NotificationsPage />, {
      i18n: { bundle: BUNDLE },
      auth: { currentUser: buildCurrentUser({ permissions: new Set(['notify.notification.read', 'notify.notification.update']) }) },
    })

    expect(await screen.findByText('Your leave request was approved')).toBeInTheDocument()
    expect(screen.getByText('Unread')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument()
  })

  /**
   * `auditor-readonly` holds `notify.notification.read` but never
   * `.update` (Security doc §4.2: "Explicitly denied: any write") — the
   * exact case `useHasPermission` gates the Mark-read button on, so a
   * caller in that shape never sees a button the server would 403.
   */
  it('hides the Mark read control for a caller who can read but not update notifications', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { notifications: [UNREAD_NOTIFICATION] })))

    renderWithProviders(<NotificationsPage />, {
      i18n: { bundle: BUNDLE },
      auth: { currentUser: buildCurrentUser({ permissions: new Set(['notify.notification.read']) }) },
    })

    expect(await screen.findByText('Your leave request was approved')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark read' })).not.toBeInTheDocument()
  })

  it('shows the empty state when there are no notifications', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { notifications: [] })))

    renderWithProviders(<NotificationsPage />, { i18n: { bundle: BUNDLE } })

    expect(await screen.findByText('No notifications.')).toBeInTheDocument()
  })

  it('clicking Mark read fires a real POST .../read request and refreshes the list', async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/read')) {
        return Promise.resolve(jsonResponse(200, { ...UNREAD_NOTIFICATION, readAt: '2026-01-16T00:00:00.000Z' }))
      }
      return Promise.resolve(jsonResponse(200, { notifications: [UNREAD_NOTIFICATION] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(<NotificationsPage />, {
      i18n: { bundle: BUNDLE },
      auth: { currentUser: buildCurrentUser({ permissions: new Set(['notify.notification.read', 'notify.notification.update']) }) },
    })

    await screen.findByText('Your leave request was approved')
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }))

    await waitFor(() => {
      const readCall = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/read') && (init as RequestInit)?.method === 'POST')
      expect(readCall).toBeDefined()
    })
  })

  it('toggling "Unread only" re-fetches with the unread query param', async () => {
    // `mockImplementation`, not `mockResolvedValue` — this test fires two
    // requests (initial load, then the toggle) against the same stub, and a
    // `Response` body can only be read once; see the `RolesPage.test.tsx`
    // beforeEach for the same fix with the full explanation.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(200, { notifications: [] })))
    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(<NotificationsPage />, { i18n: { bundle: BUNDLE } })

    await screen.findByText('No notifications.')
    fireEvent.click(screen.getByRole('button', { name: 'Unread only' }))

    await waitFor(() => {
      const unreadCall = fetchMock.mock.calls.find(([input]) => String(input).includes('unread=true'))
      expect(unreadCall).toBeDefined()
    })
  })
})
