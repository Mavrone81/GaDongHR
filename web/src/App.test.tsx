import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { AuthGate } from './App'
import { renderWithProviders } from './test/testUtils'

/**
 * "A 401 triggers re-auth, not a blank screen" (task brief). `httpClient.test.ts`
 * proves the 401 -> `onUnauthorized` mechanics in isolation; this proves
 * the OTHER half — that `AuthContext.status === 'unauthenticated'` (exactly
 * what `onUnauthorized` sets, see `AuthContext.tsx`'s `tokenSource`) renders
 * a real, visible login screen under `AuthGate`, never an empty `<Outlet/>`.
 */
describe('AuthGate', () => {
  function tree(): React.JSX.Element {
    return (
      <Routes>
        <Route element={<AuthGate />}>
          <Route index element={<div>protected content</div>} />
        </Route>
      </Routes>
    )
  }

  it('renders the sign-in screen, not a blank screen, when unauthenticated', () => {
    renderWithProviders(tree(), {
      auth: { status: 'unauthenticated', currentUser: null },
      i18n: { bundle: { 'auth.login.title': 'Sign in', 'auth.login.submit': 'Sign in' } },
    })
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText('protected content')).not.toBeInTheDocument()
  })

  it('renders the protected content (via Outlet) once authenticated', () => {
    renderWithProviders(tree(), { auth: { status: 'authenticated' } })
    expect(screen.getByText('protected content')).toBeInTheDocument()
  })
})
