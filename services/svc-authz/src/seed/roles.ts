import { createHash } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'
import { AuthzRepository } from '../authz.repository'

export const BIOMETRIC_TEMPLATE_READ = 'biometric.template.read'

export interface PermissionCatalogEntry {
  code: string
  description: string
}

export interface RoleTemplate {
  code: string
  nameI18n: Record<string, string>
  isSystem: boolean
  permissions: string[]
}

/**
 * The roadmap's "Permission catalog" (`docs/superpowers/plans/00-PROGRAM-ROADMAP.md`,
 * "Contracts every phase depends on"), 48 codes, verbatim — plus three
 * codes this task adds. Every addition is listed here, explicitly, because
 * the roadmap is the source of truth and these three are not yet reflected
 * there (Task 8 brief, carried-forward context: "list every added code
 * explicitly in your report — I will reconcile the roadmap"):
 *
 *  - `config.rule.read` — `services/svc-config/src/rules.controller.ts`
 *    already declares `@RequirePermission('config.rule.read')` on
 *    `GET /rules` and `GET /rules/:key` (merged in Task 7, before this
 *    task existed). It is not in the roadmap's catalog. Omitting it here
 *    would mean `/decide` treats it as permanently unknown → permanently
 *    denied → those two already-shipped routes silently brick for every
 *    caller, forever, the moment svc-authz is the thing actually deciding.
 *  - `authz.role.read`, `authz.role.grant` — this task's own API
 *    (`GET /roles`, `POST /users/:id/roles`, `DELETE /users/:id/roles/:roleId`)
 *    needs permissions to guard itself with, and the roadmap's catalog
 *    (written before svc-authz existed) has none for its own admin routes.
 *
 * Total: 51 (48 + 3). No other permission is invented here.
 */
export const PERMISSION_CATALOG: PermissionCatalogEntry[] = [
  { code: 'employee.create', description: 'Create a new employee record' },
  { code: 'employee.read', description: 'Read an employee record' },
  { code: 'employee.update', description: "Update an employee's own or another employee's record" },
  { code: 'employee.lifecycle', description: 'Change employment status (activate, suspend, terminate)' },
  { code: 'employee.import', description: 'Bulk-import employee records' },
  { code: 'employee.sensitive.read', description: 'Read sensitive identity fields (national ID, bank account)' },
  { code: 'onboarding.manage', description: 'Manage onboarding checklists and tasks' },
  { code: 'document.generate', description: 'Generate an employment document (contract, letter)' },
  { code: 'consent.self', description: "Grant or withdraw one's own PDPA consent" },
  { code: 'roster.read', description: 'Read a roster' },
  { code: 'roster.write', description: 'Create or edit a roster' },
  { code: 'roster.publish', description: 'Publish a roster to affected employees' },
  { code: 'ot.request', description: 'Request overtime' },
  { code: 'ot.approve', description: 'Approve requested overtime' },
  { code: 'holiday.manage', description: 'Manage the holiday calendar' },
  { code: 'punch.submit', description: 'Submit an attendance punch event' },
  { code: 'enrolment.manage', description: 'Manage biometric enrolment records (not template contents)' },
  { code: 'device.register', description: 'Register an attendance device' },
  { code: 'device.approve', description: 'Approve a registered attendance device' },
  { code: 'timesheet.read', description: 'Read a timesheet' },
  { code: 'timesheet.correct', description: 'Correct a timesheet day record' },
  { code: 'timesheet.lock', description: 'Lock a timesheet period' },
  { code: 'timesheet.unlock', description: 'Unlock a locked timesheet period (Payroll Approver only, with reason)' },
  { code: 'leave.request', description: 'Submit a leave request' },
  { code: 'leave.approve', description: 'Approve a leave request' },
  { code: 'leave.admin', description: 'Administer leave types, balances and corrections' },
  { code: 'leave.balance.read', description: "Read an employee's leave balance" },
  { code: 'claim.submit', description: 'Submit an expense claim' },
  { code: 'claim.approve', description: 'Approve an expense claim' },
  { code: 'claim.approve.finance', description: 'Finance-level approval of an expense claim' },
  { code: 'claim.admin', description: 'Administer claim types and bands' },
  { code: 'payroll.profile.read', description: "Read an employee's payroll profile" },
  { code: 'payroll.profile.write', description: "Edit an employee's payroll profile" },
  { code: 'payroll.run.prepare', description: 'Prepare a payroll run' },
  { code: 'payroll.run.calculate', description: 'Run gross-to-net calculation for a payroll run' },
  { code: 'payroll.run.approve', description: 'Approve a payroll run (never the same user as prepare — SoD)' },
  { code: 'payroll.run.commit', description: 'Commit an approved payroll run' },
  { code: 'payroll.export', description: 'Export payroll data (bank files, statutory filings)' },
  { code: 'payslip.read.self', description: "Read one's own payslip" },
  { code: 'payslip.read.any', description: "Read any employee's payslip" },
  { code: 'config.rule.propose', description: 'Propose a new statutory config rule version' },
  { code: 'config.rule.approve', description: 'Approve a proposed statutory config rule (never the proposer — SoD)' },
  { code: 'config.pack.import', description: 'Import a signed statutory rule pack' },
  { code: 'audit.read', description: 'Read the audit trail' },
  { code: 'dpo.console', description: "Access the DPO's PDPA console" },
  { code: 'dsr.manage', description: 'Manage data subject requests' },
  { code: 'retention.approve', description: 'Approve a retention/erasure action' },
  { code: BIOMETRIC_TEMPLATE_READ, description: 'Read a raw biometric face template — machine grant to svc-attendance ONLY, never a human role (Security doc §4.2, absolute)' },
  // --- additions beyond the roadmap's list (see comment above) ---
  { code: 'config.rule.read', description: 'Read an effective-dated statutory config rule' },
  { code: 'authz.role.read', description: 'Read role and permission catalog data' },
  { code: 'authz.role.grant', description: 'Grant or revoke a role assignment' },
]

/**
 * The ten role templates the roadmap names ("Role templates") and Security
 * doc §4.2 defines. Every assignment below follows §4.2's "Highlights" AND
 * "Explicitly denied" columns — the denials are requirements, not gaps:
 * `payroll-officer` must never carry `payroll.run.approve` (SoD),
 * `hr-officer` must never carry any `payroll.*` or `biometric.template.read`.
 * `seed/roles.test.ts` asserts every one of these denials by name.
 *
 * `biometric.template.read` is deliberately absent from every entry here —
 * see `assertNoBiometricGrant` below, which makes that omission a checked
 * invariant, not just an absence someone could quietly "fix" later.
 */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    code: 'employee-ess',
    nameI18n: { en: 'Employee Self-Service', th: 'พนักงาน (บริการตนเอง)' },
    isSystem: true,
    permissions: [
      'employee.read',
      'employee.update',
      'punch.submit',
      'leave.request',
      'leave.balance.read',
      'claim.submit',
      'payslip.read.self',
      'consent.self',
    ],
  },
  {
    code: 'line-manager',
    nameI18n: { en: 'Line Manager', th: 'ผู้จัดการสายงาน' },
    isSystem: true,
    permissions: [
      'employee.read',
      'roster.read',
      'roster.write',
      'roster.publish',
      'ot.approve',
      'timesheet.read',
      'timesheet.correct',
      'leave.approve',
      'claim.approve',
    ],
  },
  {
    code: 'hr-officer',
    nameI18n: { en: 'HR Officer', th: 'เจ้าหน้าที่ทรัพยากรบุคคล' },
    isSystem: true,
    permissions: [
      'employee.create',
      'employee.read',
      'employee.update',
      'employee.lifecycle',
      'employee.import',
      'employee.sensitive.read',
      'onboarding.manage',
      'document.generate',
      'leave.admin',
      'leave.balance.read',
      'timesheet.read',
      'timesheet.correct',
      'holiday.manage',
      'config.rule.read',
    ],
  },
  {
    code: 'payroll-officer',
    nameI18n: { en: 'Payroll Officer', th: 'เจ้าหน้าที่บัญชีเงินเดือน' },
    isSystem: true,
    // No payroll.run.approve (SoD) and no employee.create/employee.update.
    permissions: [
      'payroll.profile.read',
      'payroll.profile.write',
      'payroll.run.prepare',
      'payroll.run.calculate',
      'payroll.export',
      'config.rule.read',
    ],
  },
  {
    code: 'payroll-approver',
    nameI18n: { en: 'Payroll Approver', th: 'ผู้อนุมัติเงินเดือน' },
    isSystem: true,
    // No payroll.run.prepare/payroll.run.calculate (SoD inverse).
    permissions: ['payroll.run.approve', 'payroll.run.commit', 'payroll.profile.read', 'timesheet.unlock', 'config.rule.read'],
  },
  {
    code: 'hr-system-admin',
    nameI18n: { en: 'HR / System Admin', th: 'ผู้ดูแลระบบทรัพยากรบุคคล' },
    isSystem: true,
    // No config.rule.approve (SoD), no payroll.*, no biometric.template.read — ever.
    permissions: [
      'authz.role.read',
      'authz.role.grant',
      'config.rule.propose',
      'config.rule.read',
      'config.pack.import',
      'device.register',
      'device.approve',
      'enrolment.manage',
    ],
  },
  {
    code: 'compliance-approver',
    nameI18n: { en: 'Compliance / Second Approver', th: 'ผู้อนุมัติลำดับที่สอง' },
    isSystem: true,
    // No config.rule.propose (SoD — cannot propose what it approves).
    permissions: ['config.rule.approve', 'config.rule.read'],
  },
  {
    code: 'dpo',
    nameI18n: { en: 'Data Protection Officer', th: 'เจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคล' },
    isSystem: true,
    permissions: ['dpo.console', 'dsr.manage', 'retention.approve'],
  },
  {
    code: 'auditor-readonly',
    nameI18n: { en: 'Auditor (read-only)', th: 'ผู้ตรวจสอบ (อ่านอย่างเดียว)' },
    isSystem: true,
    permissions: ['audit.read'],
  },
  {
    code: 'kiosk-device',
    nameI18n: { en: 'Kiosk Device', th: 'อุปกรณ์ตู้คีออสก์' },
    isSystem: true,
    permissions: ['punch.submit'],
  },
]

/**
 * The application-level "brace" (see the migration's
 * `role_permission_no_biometric_check` for the DB-level "belt"): throws if
 * ANY template — `hr-system-admin` included — carries
 * `biometric.template.read`. Called by `seedRoleTemplates` before a single
 * row is written, so a future edit that adds it to a template fails the
 * build/boot loudly rather than silently seeding a forbidden grant.
 */
export function assertNoBiometricGrant(templates: RoleTemplate[]): void {
  for (const template of templates) {
    if (template.permissions.includes(BIOMETRIC_TEMPLATE_READ)) {
      throw new Error(
        `seed/roles.ts: role template "${template.code}" must not carry ${BIOMETRIC_TEMPLATE_READ} — Security doc §4.2: no human role holds it, ever.`,
      )
    }
  }
}

/**
 * Seeds the full permission catalog and all ten role templates through
 * `tx` — the CALLER's transaction handle, matching every other write in
 * this codebase (`writeOutbox`, `idempotent`, `RulesService.approve`). Run
 * on every boot (`main.ts`), and idempotent: `AuthzRepository.upsertPermission`/
 * `upsertRole` are upserts, and `replaceRolePermissions` is delete-then-
 * reinsert, so seeding N times leaves the same state as seeding once
 * (Task 8 brief §5) — proven by `seedContentHash` in `seed/roles.test.ts`.
 */
export async function seedRoleTemplates(tx: Queryable): Promise<void> {
  assertNoBiometricGrant(ROLE_TEMPLATES)

  const repo = new AuthzRepository(tx)
  for (const entry of PERMISSION_CATALOG) {
    await repo.upsertPermission(tx, entry.code, entry.description)
  }
  for (const template of ROLE_TEMPLATES) {
    const role = await repo.upsertRole(tx, template.code, template.nameI18n, template.isSystem)
    await repo.replaceRolePermissions(tx, role.id, template.permissions)
  }
}

/**
 * A canonical SHA-256 over the seeded state — roles, the full permission
 * catalog, and every role→permission edge — read back entirely through
 * `AuthzRepository`'s public API (so this works identically against the
 * fake in tests and a real Postgres later; it never reaches into
 * `testing/fake-db.ts`'s internals). Role ids and grant timestamps are
 * deliberately excluded: they are storage details, not the seeded content
 * this function is proving is byte-identical after a second seed pass.
 */
export async function seedContentHash(pool: Queryable): Promise<string> {
  const repo = new AuthzRepository(pool)

  const roles = (await repo.listRoles())
    .map((r) => ({ code: r.code, nameI18n: r.nameI18n, isSystem: r.isSystem }))
    .sort((a, b) => a.code.localeCompare(b.code))

  const permissions = (await repo.listPermissions())
    .map((p) => ({ code: p.code, description: p.description }))
    .sort((a, b) => a.code.localeCompare(b.code))

  const rolesWithIds = await repo.listRoles()
  const rolePermissions: Array<{ role: string; permission: string }> = []
  for (const role of rolesWithIds) {
    const codes = await repo.listPermissionCodesForRole(role.id)
    for (const code of codes) rolePermissions.push({ role: role.code, permission: code })
  }
  rolePermissions.sort((a, b) => (a.role === b.role ? a.permission.localeCompare(b.permission) : a.role.localeCompare(b.role)))

  const canonical = JSON.stringify({ roles, permissions, rolePermissions })
  return createHash('sha256').update(canonical).digest('hex')
}
