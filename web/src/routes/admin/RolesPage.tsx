import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { useAuth } from '../../auth/AuthContext'
import { useHasPermission } from '../../auth/permissions'
import { useSvcAuthz } from '../../api/svcAuthz'
import type { RoleWithPermissions } from '../../api/svcAuthz'
import { ApiError } from '../../api/httpClient'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import { Eyebrow } from '../../components/Eyebrow'
import { Field } from '../../components/Field'
import { Button } from '../../components/Button'
import { Table, TableCell, TableHeaderCell } from '../../components/Table'
import '../../components/page.css'
import './roles.css'

/** `nameI18n` (`services/svc-authz/src/seed/roles.ts`'s `RoleTemplate`) only ever carries `en`/`th` — no `zh` entry exists in any seeded role today. Falls back through the same chain `I18nContext.tsx`'s `t()` uses (requested locale -> en -> th), landing on the role's own `code` only if neither translation is present at all. */
function roleName(role: RoleWithPermissions, locale: string): string {
  return role.nameI18n[locale] ?? role.nameI18n['en'] ?? role.nameI18n['th'] ?? role.code
}

function RolesTable({ roles }: { roles: RoleWithPermissions[] }): React.JSX.Element {
  const { t, locale } = useI18n()
  return (
    <Table caption={t('admin.roles.title')}>
      <thead>
        <tr>
          <TableHeaderCell>{t('admin.roles.table.code')}</TableHeaderCell>
          <TableHeaderCell>{t('admin.roles.table.name')}</TableHeaderCell>
          <TableHeaderCell>{t('admin.roles.table.permissions')}</TableHeaderCell>
          <TableHeaderCell>{t('admin.roles.table.system')}</TableHeaderCell>
        </tr>
      </thead>
      <tbody>
        {roles.map((role) => (
          <tr key={role.id}>
            <TableCell className="roles-code raw-code">{role.code}</TableCell>
            <TableCell>{roleName(role, locale)}</TableCell>
            {/* `raw-code`: real `authz.permission` codes (e.g. `leave.admin`), not translatable
                prose — see `e2e/assertions.ts`'s header for what this marker does and does not exempt. */}
            <TableCell className="roles-permissions raw-code">{role.permissions.join(', ')}</TableCell>
            <TableCell>{role.isSystem ? t('common.yes') : t('common.no')}</TableCell>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

/**
 * `POST /users/:id/roles`. There is no user directory anywhere in
 * `svc-authz` (or any service this app talks to), so the person being
 * granted a role is identified only by the raw user id typed into this
 * form — the confirmation dialog below names exactly that id and the
 * role's own code, the only two identifiers this API can give a caller
 * (task brief: "guard destructive actions behind confirmation naming the
 * person and role — this screen moves real authority").
 */
function GrantPanel({
  roles,
  grantedBy,
  onGranted,
}: {
  roles: RoleWithPermissions[]
  grantedBy: string
  onGranted: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const svcAuthz = useSvcAuthz()
  const [userId, setUserId] = useState('')
  const [roleId, setRoleId] = useState('')
  const [orgScopeUnitId, setOrgScopeUnitId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const effectiveRoleId = roleId || roles[0]?.id || ''

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const role = roles.find((r) => r.id === effectiveRoleId)
      if (!role) return
      if (!window.confirm(t('admin.roles.grant.confirm', { role: role.code, userId }))) return

      setSubmitting(true)
      setEnvelope(null)
      setSuccess(null)
      svcAuthz
        .grantRole(userId.trim(), role.id, grantedBy, orgScopeUnitId.trim() || null)
        .then(() => {
          setSuccess(t('admin.roles.grant.success', { role: role.code, userId }))
          onGranted()
        })
        .catch((err: unknown) => setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null))
        .finally(() => setSubmitting(false))
    },
    [roles, effectiveRoleId, userId, orgScopeUnitId, grantedBy, svcAuthz, onGranted, t],
  )

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <Eyebrow>{t('admin.roles.grant.title')}</Eyebrow>

      <Field label={t('admin.roles.grant.userId')} htmlFor="roles-grant-user-id">
        <input id="roles-grant-user-id" value={userId} onChange={(e) => setUserId(e.target.value)} required />
      </Field>

      <Field label={t('admin.roles.grant.role')} htmlFor="roles-grant-role">
        <select id="roles-grant-role" value={effectiveRoleId} onChange={(e) => setRoleId(e.target.value)} required>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {roleName(role, locale)}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('admin.roles.grant.orgScopeUnitId')} htmlFor="roles-grant-org-scope">
        <input id="roles-grant-org-scope" value={orgScopeUnitId} onChange={(e) => setOrgScopeUnitId(e.target.value)} />
      </Field>

      <p className="panel__actions">
        <Button type="submit" variant="primary" disabled={submitting || !effectiveRoleId}>
          {t('admin.roles.grant.submit')}
        </Button>
      </p>

      {envelope && <p className="roles-error">{t(envelope.message_i18n_key)}</p>}
      {success && <p>{success}</p>}
    </form>
  )
}

/** `DELETE /users/:id/roles/:roleId`. Same identification gap and same confirmation pattern as `GrantPanel` above — see that component's header. */
function RevokePanel({ roles }: { roles: RoleWithPermissions[] }): React.JSX.Element {
  const { t, locale } = useI18n()
  const svcAuthz = useSvcAuthz()
  const [userId, setUserId] = useState('')
  const [roleId, setRoleId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const effectiveRoleId = roleId || roles[0]?.id || ''

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const role = roles.find((r) => r.id === effectiveRoleId)
      if (!role) return
      if (!window.confirm(t('admin.roles.revoke.confirm', { role: role.code, userId }))) return

      setSubmitting(true)
      setEnvelope(null)
      setSuccess(null)
      svcAuthz
        .revokeRole(userId.trim(), role.id)
        .then(() => setSuccess(t('admin.roles.revoke.success', { role: role.code, userId })))
        .catch((err: unknown) => setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null))
        .finally(() => setSubmitting(false))
    },
    [roles, effectiveRoleId, userId, svcAuthz, t],
  )

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <Eyebrow>{t('admin.roles.revoke.title')}</Eyebrow>

      <Field label={t('admin.roles.revoke.userId')} htmlFor="roles-revoke-user-id">
        <input id="roles-revoke-user-id" value={userId} onChange={(e) => setUserId(e.target.value)} required />
      </Field>

      <Field label={t('admin.roles.revoke.role')} htmlFor="roles-revoke-role">
        <select id="roles-revoke-role" value={effectiveRoleId} onChange={(e) => setRoleId(e.target.value)} required>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {roleName(role, locale)}
            </option>
          ))}
        </select>
      </Field>

      <p className="panel__actions">
        <Button type="submit" variant="secondary" disabled={submitting || !effectiveRoleId}>
          {t('admin.roles.revoke.submit')}
        </Button>
      </p>

      {envelope && <p className="roles-error">{t(envelope.message_i18n_key)}</p>}
      {success && <p>{success}</p>}
    </form>
  )
}

/**
 * The RBAC surface `svc-authz` actually serves (task brief: "roles, their
 * permissions, who holds them; grant/revoke if the API supports it").
 * `GET /roles` gives the first two for real. The third — who currently
 * holds a role — has no backing route at all: `svc-authz` exposes no
 * "list grants" endpoint, only the two mutations below, each of which
 * returns just the one grant it acted on. This screen does not invent a
 * roster to fill that gap; grant/revoke are real, confirmed, permission-
 * gated actions, and the absence of a "who holds this role today" table is
 * a reported gap, not a stubbed one.
 */
export function RolesPage(): React.JSX.Element {
  const { t } = useI18n()
  const { currentUser } = useAuth()
  const svcAuthz = useSvcAuthz()
  const canGrant = useHasPermission('authz.role.grant')
  const [roles, setRoles] = useState<RoleWithPermissions[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    svcAuthz
      .listRoles()
      .then(setRoles)
      .finally(() => setLoading(false))
  }, [svcAuthz])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <section className="page">
      <header className="page__header">
        <Eyebrow>{t('shell.brand')}</Eyebrow>
        <h1 className="page__title">{t('admin.roles.title')}</h1>
      </header>

      {loading && <p>{t('common.loading')}</p>}
      {!loading && roles.length === 0 && <p className="empty-state">{t('admin.roles.emptyState')}</p>}
      {!loading && roles.length > 0 && <RolesTable roles={roles} />}

      {canGrant && currentUser && roles.length > 0 && (
        <>
          <GrantPanel roles={roles} grantedBy={currentUser.id} onGranted={reload} />
          <RevokePanel roles={roles} />
        </>
      )}
    </section>
  )
}
