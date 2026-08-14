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

/**
 * `onboarding.employee.org_unit_id`/`onboarding.position.org_unit_id` both
 * carry a real FK (`employee_org_unit_id_fkey`/`position_org_unit_id_fkey`,
 * `services/svc-onboarding/migrations/1756000000000_onboarding-schema.js`)
 * into `onboarding.org_unit` — `POST /employees` 500s on a foreign-key
 * violation for any `orgUnitId`/`positionId` that doesn't already exist.
 * `EmployeeController` has no route to create an org unit or position
 * (M1's scope stops at the employee record itself), so the e2e harness
 * seeds the two fixed ids the lifecycle test hires into directly — this is
 * pure test-data setup (an org chart has to come from somewhere before the
 * first hire), not a shortcut around any guard or business rule under
 * test.
 */
export async function seedOnboardingOrgAndPosition(orgUnitId: string, positionId: string): Promise<void> {
  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO onboarding.org_unit (id, parent_id, name_i18n, cost_center)
       VALUES ($1::uuid, NULL, '{"en":"E2E HQ","th":"E2E HQ"}'::jsonb, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [orgUnitId],
    )
    await client.query(
      `INSERT INTO onboarding.position (id, code, title_i18n, org_unit_id)
       VALUES ($1::uuid, 'E2E-POS-1', '{"en":"E2E Tester","th":"E2E Tester"}'::jsonb, $2::uuid)
       ON CONFLICT (id) DO NOTHING`,
      [positionId, orgUnitId],
    )
  })
}

/**
 * Row-scoping fix (roadmap "🔴 Open security gap") test support: seeds an
 * `authz.org_unit` row directly. `authz.user_role.org_scope_unit_id` carries
 * a real FK into this table (`services/svc-authz/migrations/
 * 1754100000000_authz-schema.js`), so `grantScopedPermission` below cannot
 * grant an org-scoped permission for an org unit `svc-authz` has never
 * heard of — in production this table is populated by consuming
 * `employee.created`/`employee.updated` (`AuthzService.applyEmployeeCreated`),
 * which no running consumer loop wires up yet (`authz.service.ts`'s own
 * doc); this is the same direct-SQL test-data-setup precedent
 * `seedOnboardingOrgAndPosition` above already establishes for
 * `onboarding.org_unit`/`onboarding.position` — not a shortcut around the
 * guard or scope logic under test.
 */
export async function seedAuthzOrgUnit(id: string, nameEn: string): Promise<void> {
  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO authz.org_unit (id, parent_id, name_i18n, cost_center)
       VALUES ($1::uuid, NULL, $2::jsonb, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [id, JSON.stringify({ en: nameEn, th: nameEn })],
    )
  })
}

/**
 * Row-scoping fix test support: grants `permissionCode` to `userId` scoped
 * to exactly `orgUnitId` (an org-scoped grant — `authz.user_role
 * .org_scope_unit_id` set, not `NULL`), so `AuthzService.decide()` resolves
 * `scopeOrgUnitIds` to that unit's subtree rather than `'self'`. Same
 * throwaway-role mechanism as `grantPermission` above (a permission with no
 * existing `ROLE_TEMPLATES` entry that grants it scoped, which is exactly
 * this case: no template grants any permission WITH an org scope — that is
 * assigned per-grant, by `POST /users/:id/roles`'s real `orgScopeUnitId`
 * body field, which this mirrors), keyed additionally on `orgUnitId` so
 * granting the same permission scoped to two different org units (as the
 * cross-org-unit-denial test does) does not collide on one throwaway role.
 */
export async function grantScopedPermission(userId: string, permissionCode: string, orgUnitId: string, grantedBy: string): Promise<void> {
  const roleCode = `e2e-machine-scoped-${permissionCode.replace(/\./g, '-')}-${orgUnitId.slice(-8)}`
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
      `INSERT INTO authz.user_role (user_id, role_id, org_scope_unit_id, granted_by)
       SELECT $1::uuid, r.id, $3::uuid, $4::uuid
       FROM authz.role r
       WHERE r.code = $2
         AND NOT EXISTS (
           SELECT 1 FROM authz.user_role ur WHERE ur.user_id = $1::uuid AND ur.role_id = r.id
         )`,
      [userId, roleCode, orgUnitId, grantedBy],
    )
  })
}

export async function waitForRoleSeeded(roleCode: string): Promise<boolean> {
  return withSuperuserClient(async (client) => {
    const res = await client.query('SELECT 1 FROM authz.role WHERE code = $1', [roleCode])
    return (res.rowCount ?? 0) > 0
  })
}
