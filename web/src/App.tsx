import { useEffect, useRef } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { I18nProvider } from './i18n/I18nContext'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { Shell } from './routes/Shell'
import { LoginPage } from './routes/LoginPage'
import { CallbackPage } from './routes/CallbackPage'
import { ComingSoon } from './routes/ComingSoon'
import { RequirePermission } from './routes/RequirePermission'
import { StatutoryRulesPage } from './routes/admin/StatutoryRulesPage'
import { AuditPage } from './routes/compliance/AuditPage'
import { DocumentsPage } from './routes/documents/DocumentsPage'
import { RolesPage } from './routes/admin/RolesPage'
import { NotificationsPage } from './routes/notifications/NotificationsPage'
import { DEFAULT_NAV_PATH } from './routes/navigation'

/**
 * "A 401 triggers re-auth, not a blank screen" (task brief). `AuthContext`'s
 * `onUnauthorized` (wired into every API client via `AuthTokenSource`, see
 * `api/httpClient.ts`) flips `status` back to `unauthenticated` the moment a
 * 401 survives a refresh attempt. This layout route is what turns that
 * state change into a visible screen: every authenticated route is nested
 * under it, so losing auth anywhere immediately swaps the whole tree for
 * `LoginPage` — never a blank `<Outlet/>`. `reason="expired"` distinguishes
 * "you were signed in and got logged out" from a fresh, never-authenticated
 * visit.
 */
export function AuthGate(): React.JSX.Element {
  const { status, authError } = useAuth()
  const everAuthenticated = useRef(false)

  useEffect(() => {
    if (status === 'authenticated') everAuthenticated.current = true
  }, [status])

  if (status !== 'authenticated') {
    // A concrete failure outranks "your session expired": if the callback
    // told us WHY this attempt died, say that instead of the generic
    // timeout copy, which would be actively misleading for someone who
    // just cancelled at the Keycloak page.
    return <LoginPage reason={authError ?? (everAuthenticated.current ? 'expired' : undefined)} />
  }
  return <Outlet />
}

function ShellRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/auth/callback" element={<CallbackPage />} />
      <Route element={<AuthGate />}>
        <Route element={<Shell />}>
          <Route index element={<Navigate to={DEFAULT_NAV_PATH} replace />} />
          <Route
            path="admin/statutory-rules"
            element={
              <RequirePermission permission="config.rule.read">
                <StatutoryRulesPage />
              </RequirePermission>
            }
          />
          <Route
            path="compliance/audit"
            element={
              <RequirePermission permission="audit.read">
                <AuditPage />
              </RequirePermission>
            }
          />
          <Route
            path="documents"
            element={
              <RequirePermission permission="document.read">
                <DocumentsPage />
              </RequirePermission>
            }
          />
          <Route
            path="admin/roles"
            element={
              <RequirePermission permission="authz.role.read">
                <RolesPage />
              </RequirePermission>
            }
          />
          <Route
            path="notifications"
            element={
              <RequirePermission permission="notify.notification.read">
                <NotificationsPage />
              </RequirePermission>
            }
          />
          <Route path="*" element={<ComingSoon />} />
        </Route>
      </Route>
    </Routes>
  )
}

export function App(): React.JSX.Element {
  return (
    <I18nProvider>
      <AuthProvider>
        <BrowserRouter>
          <ShellRoutes />
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  )
}
