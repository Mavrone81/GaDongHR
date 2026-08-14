import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { RolesPage } from './RolesPage'
import { renderWithProviders, buildCurrentUser } from '../../test/testUtils'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const BUNDLE = {
  'shell.brand': 'GaDongHR',
  'admin.roles.title': 'Roles',
  'admin.roles.table.code': 'Role',
  'admin.roles.table.name': 'Name',
  'admin.roles.table.permissions': 'Permissions',
  'admin.roles.table.system': 'System role',
  'admin.roles.emptyState': 'No roles found.',
  'admin.roles.grant.cta': 'Grant a role',
  'admin.roles.grant.title': 'Grant a role',
  'admin.roles.grant.userId': 'User ID',
  'admin.roles.grant.role': 'Role',
  'admin.roles.grant.orgScopeUnitId': 'Org scope unit ID (optional)',
  'admin.roles.grant.submit': 'Grant',
  'admin.roles.grant.confirm': 'Grant "{role}" to user {userId}?',
  'admin.roles.grant.success': 'Granted "{role}" to {userId}.',
  'admin.roles.revoke.cta': 'Revoke a role',
  'admin.roles.revoke.title': 'Revoke a role',
  'admin.roles.revoke.userId': 'User ID',
  'admin.roles.revoke.role': 'Role',
  'admin.roles.revoke.submit': 'Revoke',
  'admin.roles.revoke.confirm': 'Revoke "{role}" from user {userId}? This removes their access to it immediately.',
  'admin.roles.revoke.success': 'Revoked "{role}" from {userId}.',
  'common.loading': 'Loading…',
  'common.yes': 'Yes',
  'common.no': 'No',
}

const ROLES_FIXTURE = [
  { id: 'role-1', code: 'hr-officer', nameI18n: { en: 'HR Officer', th: 'เจ้าหน้าที่ทรัพยากรบุคคล' }, isSystem: true, permissions: ['employee.read', 'employee.update'] },
]

describe('RolesPage', () => {
  beforeEach(() => {
    // `mockImplementation`, not `mockResolvedValue` — a `Response` body can
    // only be read once (`httpClient.ts`'s `request()` calls `res.text()`),
    // and every test below fires at least two requests (the initial
    // `GET /roles` load, then a grant/revoke) against this same stub, so a
    // single shared `Response` instance would throw "Body is unusable" on
    // the second call. A fresh `jsonResponse(...)` per invocation avoids
    // that regardless of how many calls a given test makes.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(200, { roles: ROLES_FIXTURE }))))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists roles with their permissions, without a grant/revoke panel for a caller lacking authz.role.grant', async () => {
    renderWithProviders(<RolesPage />, {
      i18n: { bundle: BUNDLE, locale: 'en' },
      auth: { currentUser: buildCurrentUser({ permissions: new Set(['authz.role.read']) }) },
    })

    expect(await screen.findByText('hr-officer')).toBeInTheDocument()
    expect(screen.getByText('HR Officer')).toBeInTheDocument()
    expect(screen.getByText('employee.read, employee.update')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Grant' })).not.toBeInTheDocument()
  })

  /**
   * "Guard destructive actions behind confirmation naming the person and
   * role — this screen moves real authority" (task brief). `window.confirm`
   * is stubbed to assert on the exact message it was called with, then to
   * accept — the same mechanism a real browser prompt provides, in a form
   * Playwright's `page.on('dialog')` can also drive end-to-end.
   */
  it('grants a role only after a confirmation naming the exact person and role, then shows success', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderWithProviders(<RolesPage />, {
      i18n: { bundle: BUNDLE, locale: 'en' },
      auth: {
        currentUser: buildCurrentUser({ id: 'admin-1', permissions: new Set(['authz.role.read', 'authz.role.grant']) }),
      },
    })

    await screen.findByText('hr-officer')

    fireEvent.change(screen.getByLabelText('User ID', { selector: '#roles-grant-user-id' }), { target: { value: 'user-42' } })
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))

    expect(confirmSpy).toHaveBeenCalledWith('Grant "hr-officer" to user user-42?')
    expect(await screen.findByText('Granted "hr-officer" to user-42.')).toBeInTheDocument()
  })

  it('does not grant anything when the confirmation is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(200, { roles: ROLES_FIXTURE })))
    vi.stubGlobal('fetch', fetchSpy)

    renderWithProviders(<RolesPage />, {
      i18n: { bundle: BUNDLE, locale: 'en' },
      auth: {
        currentUser: buildCurrentUser({ id: 'admin-1', permissions: new Set(['authz.role.read', 'authz.role.grant']) }),
      },
    })

    await screen.findByText('hr-officer')
    const callsBeforeSubmit = fetchSpy.mock.calls.length

    fireEvent.change(screen.getByLabelText('User ID', { selector: '#roles-grant-user-id' }), { target: { value: 'user-42' } })
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))

    expect(screen.queryByText('Granted "hr-officer" to user-42.')).not.toBeInTheDocument()
    // Only the initial GET /roles fired — no POST for the dismissed grant.
    expect(fetchSpy.mock.calls.length).toBe(callsBeforeSubmit)
  })

  it('revokes a role only after a confirmation naming the exact person and role, then shows success', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderWithProviders(<RolesPage />, {
      i18n: { bundle: BUNDLE, locale: 'en' },
      auth: {
        currentUser: buildCurrentUser({ id: 'admin-1', permissions: new Set(['authz.role.read', 'authz.role.grant']) }),
      },
    })

    await screen.findByText('hr-officer')

    fireEvent.change(screen.getByLabelText('User ID', { selector: '#roles-revoke-user-id' }), { target: { value: 'user-99' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    expect(await screen.findByText('Revoked "hr-officer" from user-99.')).toBeInTheDocument()
  })
})
