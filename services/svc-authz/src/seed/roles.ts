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
 * "Contracts every phase depends on"), 48 codes, verbatim — plus six codes
 * this task adds. Every addition is listed here, explicitly, because the
 * roadmap is the source of truth and these six are not yet reflected there
 * (Task 8 brief, carried-forward context: "list every added code explicitly
 * in your report — I will reconcile the roadmap"):
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
 *  - `document.read`, `notify.notification.read`, `notify.notification.update`
 *    — Task 14c fix. These three were named in the roadmap's permission
 *    catalog LIST (2026-08-03 addendum) but never reached this file's
 *    `PERMISSION_CATALOG` at all — not merely ungranted, but genuinely
 *    unknown to `/decide` (`AuthzService.decide` calls `findPermissionByCode`
 *    before it ever looks at a grant, so a code missing here denies
 *    unconditionally, before role membership is even consulted). Their
 *    routes (`GET/POST /notifications*` in svc-notify, `GET /documents/:id`
 *    in svc-docs) were live and correctly guarded, but 403'd for every
 *    caller including hr-system-admin — the notification inbox and document
 *    viewer were unreachable by design, not by bug, until this fix.
 *
 * Total: 54 (48 + 6). No other permission is invented here.
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
  { code: 'document.read', description: 'Read/download a previously rendered document (contract, letter, payslip)' },
  { code: 'notify.notification.read', description: "Read one's own in-app notifications" },
  { code: 'notify.notification.update', description: "Mark one's own in-app notification read" },
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
      // M1/M2/M5/M6 reconciliation (2026-08-04): `roster.read` and
      // `ot.request` power `GET /my/schedule` and `POST /ot-requests` in
      // svc-scheduler — an employee viewing their own upcoming shifts and
      // requesting their own overtime (PRD M2-5: "Manager (or
      // employee-request) OT"; `ot.controller.ts`'s own comment: "an
      // employee requesting their own OT relies on the authenticated
      // caller's own id"). Before this fix `ot.request` was granted to NO
      // role — the route existed, correctly guarded, and was unreachable by
      // anyone, the exact Task 14c defect shape.
      //
      // `roster.read` is the SAME coarse permission `GET /rosters` (the full
      // team grid) uses — this role template does not yet have a narrower
      // `roster.read.self`, so this grant carries the same accepted,
      // documented scope gap as `document.read` above (see that comment):
      // `RosterController` does not row-scope by caller identity beyond the
      // one self-scoped route, so an `employee-ess` grant technically also
      // authorizes the team-grid route at the permission-check level. This
      // mirrors the roadmap's own open item ("🔴 Open security gap — GET
      // /documents/:id has no ownership scoping") rather than inventing a
      // one-off fix for scheduler alone; a real fix needs a scoped/self
      // permission split across both routes, tracked as follow-up work, not
      // papered over here.
      'roster.read',
      'ot.request',
      // Task 14c: notify.notification.* are self-scoped by construction —
      // `NotifyController` derives the recipient solely from `req.userId`,
      // never a request param, so every human role gets these two, not a
      // subset (Security doc §4.1 "`self` scope powers ESS"). document.read
      // guards `GET /documents/:id`, which has no per-document ownership
      // check of its own — ESS needs it for "own payslips" (§4.2), and this
      // is the one role for which that gap is an accepted, documented risk;
      // see this task's report for why it is not extended to hr-officer.
      'notify.notification.read',
      'notify.notification.update',
      'document.read',
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
      // M2 reconciliation (2026-08-04): PRD M2-5 — "Manager (or
      // employee-request) OT" — a manager may submit an OT request on
      // behalf of a named employee (`ot.controller.ts`'s `body.employeeId`
      // path), distinct from approving one (`ot.approve`, already held).
      'ot.request',
      'timesheet.read',
      'timesheet.correct',
      'leave.approve',
      'claim.approve',
      // Task 14c: self-scoped notification inbox — see employee-ess comment.
      'notify.notification.read',
      'notify.notification.update',
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
      // M6 reconciliation (2026-08-04): `claim.admin` (claim type/band
      // policy administration) follows the exact same pattern already
      // established for `leave.admin`/`holiday.manage` above — HR
      // administers each module's company-policy configuration. Before this
      // fix it was granted to NO role (Task 14c defect shape, again).
      'claim.admin',
      'config.rule.read',
      // Task 14c: self-scoped notification inbox — see employee-ess comment.
      // Deliberately NOT `document.read`: that permission guards
      // `GET /documents/:id` for every document kind alike (contracts AND
      // payslips — same route, same permission, no kind filter in
      // `DocumentsController`), so granting it here would let HR read
      // payroll amounts through the document viewer — exactly the side
      // door Security doc §4.2's "HR Officer ... explicitly denied: payroll
      // approve, statutory-config approve, biometric template access" (and
      // hr-system-admin's "payroll amounts by default") exists to close.
      // `document.generate` (already held) is enough for HR to produce a
      // contract; reading it back is not a stated requirement.
      'notify.notification.read',
      'notify.notification.update',
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
      // M6 reconciliation (2026-08-04): `claim.approve.finance` — PRD M6-3's
      // second approval band ("manager + finance" above 2,000 THB). The ten
      // role templates have no dedicated "Finance" persona; `payroll-officer`
      // is this catalog's closest financial function (pay profiles, bank
      // files, exports — money movement) and is not the same actor as
      // `claim.approve` (line-manager), so the two-level band is still two
      // distinct roles, not one person self-approving both levels. Before
      // this fix it was granted to NO role.
      'claim.approve.finance',
      'config.rule.read',
      // Task 14c: self-scoped notification inbox — see employee-ess comment.
      // `document.read` granted here too: this role already holds
      // `payroll.profile.read` (full salary access), so the document
      // viewer's lack of kind-filtering adds no new exposure for this role
      // the way it would for hr-officer.
      'notify.notification.read',
      'notify.notification.update',
      'document.read',
    ],
  },
  {
    code: 'payroll-approver',
    nameI18n: { en: 'Payroll Approver', th: 'ผู้อนุมัติเงินเดือน' },
    isSystem: true,
    // No payroll.run.prepare/payroll.run.calculate (SoD inverse).
    permissions: [
      'payroll.run.approve',
      'payroll.run.commit',
      'payroll.profile.read',
      'timesheet.unlock',
      'config.rule.read',
      // Task 14c: notify self-scoped inbox, and document.read for the same
      // reason as payroll-officer — already holds payroll.profile.read.
      'notify.notification.read',
      'notify.notification.update',
      'document.read',
    ],
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
      // Task 14c: self-scoped notification inbox — see employee-ess comment.
      // Deliberately NOT `document.read`, for the same side-door reason as
      // hr-officer — §4.2 denies this role "payroll amounts by default".
      'notify.notification.read',
      'notify.notification.update',
    ],
  },
  {
    code: 'compliance-approver',
    nameI18n: { en: 'Compliance / Second Approver', th: 'ผู้อนุมัติลำดับที่สอง' },
    isSystem: true,
    // No config.rule.propose (SoD — cannot propose what it approves).
    permissions: [
      'config.rule.approve',
      'config.rule.read',
      // Task 14c: self-scoped notification inbox — see employee-ess comment.
      'notify.notification.read',
      'notify.notification.update',
    ],
  },
  {
    code: 'dpo',
    nameI18n: { en: 'Data Protection Officer', th: 'เจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคล' },
    isSystem: true,
    permissions: [
      'dpo.console',
      'dsr.manage',
      'retention.approve',
      // Task 14c: self-scoped notification inbox — see employee-ess comment.
      'notify.notification.read',
      'notify.notification.update',
    ],
  },
  {
    code: 'auditor-readonly',
    nameI18n: { en: 'Auditor (read-only)', th: 'ผู้ตรวจสอบ (อ่านอย่างเดียว)' },
    isSystem: true,
    // Task 14c: document.read — §4.2's "read-only audit trail + reports,
    // scoped" and this task's brief ("auditors read within scope") both
    // name document review as part of this role's remit; auditor-readonly
    // is already the role positioned to see sensitive records for
    // compliance review, so the document viewer's lack of kind-filtering
    // does not create a new class of exposure here.
    //
    // notify.notification.read only — NOT notify.notification.update.
    // §4.2 is absolute for this role: "Auditor | ... | Explicitly denied:
    // any write". Marking a notification read is a state mutation
    // (`role.test.ts`'s "auditor-readonly holds no write-shaped
    // permission" enforces this by verb, not by guessing at intent), so
    // this role can see its inbox but not acknowledge it — a real, accepted
    // product limitation, not an oversight; see this task's report.
    permissions: ['audit.read', 'notify.notification.read', 'document.read'],
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
