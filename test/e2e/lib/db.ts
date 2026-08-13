import { Client } from 'pg'

const SUPERUSER_URL = 'postgresql://gadonghr_super:e2e-postgres-password@127.0.0.1:18542/gadonghr'

export async function withSuperuserClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: SUPERUSER_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Grants `roleCode` (an `authz.role.code` seeded by svc-authz's own
 * `seedRoleTemplates`, run on every boot — services/svc-authz/src/main.ts)
 * to `userId`, mirroring exactly the pattern
 * deploy/scripts/seed.sh uses to bootstrap the `seeder-bootstrap` role:
 * direct SQL against `authz.user_role`, the same table svc-authz's own
 * `POST /users/:id/roles` route writes to. This is test-harness
 * bootstrapping (the equivalent of a first-admin ceremony), not a
 * shortcut around the guard under test — every subsequent HTTP call in
 * the lifecycle test still goes through the real `PermissionGuard` /
 * `AuthzClient.decide()` path.
 */
export async function grantRole(userId: string, roleCode: string, grantedBy: string): Promise<void> {
  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO authz.user_role (user_id, role_id, granted_by)
       SELECT $1::uuid, r.id, $2::uuid
       FROM authz.role r
       WHERE r.code = $3
         AND NOT EXISTS (
           SELECT 1 FROM authz.user_role ur WHERE ur.user_id = $1::uuid AND ur.role_id = r.id
         )`,
      [userId, grantedBy, roleCode],
    )
  })
}

/**
 * Grants a single bare permission code to `userId` by creating (if absent)
 * a throwaway, non-system role holding exactly that one permission and
 * granting it — for permissions that are, by design, granted to NO
 * `ROLE_TEMPLATES` entry (`services/svc-authz/src/seed/roles.ts`'s
 * `PAYROLL_TIMESHEET_TOTALS_READ`/`BIOMETRIC_TEMPLATE_READ` machine-only
 * pattern), so `grantRole` (which only grants an EXISTING seeded role
 * template) cannot be used. Same bootstrapping legitimacy as `grantRole`'s
 * own doc: direct SQL against the same three tables `POST /users/:id/roles`
 * writes to, not a shortcut around `PermissionGuard` — every later HTTP
 * call still goes through the real guard/`AuthzClient.decide()` path.
 */
export async function grantPermission(userId: string, permissionCode: string, grantedBy: string): Promise<void> {
  const roleCode = `e2e-machine-${permissionCode.replace(/\./g, '-')}`
  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO authz.role (code, name_i18n, is_system)
       VALUES ($1, $2::jsonb, false)
       ON CONFLICT (code) DO NOTHING`,
      [roleCode, JSON.stringify({ en: roleCode, th: roleCode })],
    )
    await client.query(
      `INSERT INTO authz.role_permission (role_id, permission_code)
       SELECT r.id, $2 FROM authz.role r WHERE r.code = $1
       ON CONFLICT (role_id, permission_code) DO NOTHING`,
      [roleCode, permissionCode],
    )
    await client.query(
      `INSERT INTO authz.user_role (user_id, role_id, granted_by)
       SELECT $1::uuid, r.id, $3::uuid
       FROM authz.role r
       WHERE r.code = $2
         AND NOT EXISTS (SELECT 1 FROM authz.user_role ur WHERE ur.user_id = $1::uuid AND ur.role_id = r.id)`,
      [userId, roleCode, grantedBy],
    )
  })
}

export async function waitForRoleSeeded(roleCode: string): Promise<boolean> {
  return withSuperuserClient(async (client) => {
    const res = await client.query('SELECT 1 FROM authz.role WHERE code = $1', [roleCode])
    return (res.rowCount ?? 0) > 0
  })
}
