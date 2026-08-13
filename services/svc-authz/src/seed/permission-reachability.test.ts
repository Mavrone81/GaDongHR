import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BIOMETRIC_TEMPLATE_READ, PAYROLL_TIMESHEET_TOTALS_READ, ROLE_TEMPLATES } from './roles'

/**
 * The general form of Task 14c's defect: `notify.notification.read`,
 * `notify.notification.update`, and `document.read` each guarded a shipped
 * route via `@RequirePermission(...)` while being granted to zero of the ten
 * `ROLE_TEMPLATES` — `PermissionGuard` denies by default
 * (`packages/kernel/src/authz/guard.ts`), so every one of those routes 403'd
 * for every caller, forever, including `hr-system-admin`. Nothing failed:
 * the services were healthy, the routes were correctly guarded, the guard
 * did exactly what it was built to do. It took a UI-coverage cross-check
 * (`web/ui-coverage.test.ts`, Task 14b), not a test in this file, to find it.
 *
 * A test that only names those three codes by hand would just be a second
 * hard-coded list, permanently agreeing with itself — it would never catch
 * the FOURTH such defect. So this test PARSES every `@RequirePermission(...)`
 * decorator out of every source file under `services/*\/src/` (mirroring
 * `web/ui-coverage.test.ts`'s own "never hand-maintained" route parser) and
 * asserts each referenced code is granted to at least one `ROLE_TEMPLATES`
 * entry — with exactly one explicit, commented exemption below for
 * `biometric.template.read`, which is required to be granted to NO role,
 * ever (Security doc §4.2; see `assertNoBiometricGrant` and the "No human
 * role ever holds biometric.template.read" describe block in
 * `seed/roles.test.ts`). Get that exemption wrong — drop it, or list a code
 * that shouldn't be exempt — and this test either false-fails forever or
 * silently stops checking the one permission that must never be granted;
 * both failure modes are why the exemption is a single named constant, not
 * a pattern or a wildcard.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const SERVICES_DIR = join(REPO_ROOT, 'services')

/**
 * The ONLY permissions this test allows to be referenced by a decorator and
 * granted to zero roles — each a single named constant, never a pattern or
 * a wildcard (this file's own header). `biometric.template.read` is a
 * machine-only grant to svc-attendance (Security doc §4.2, absolute) — no
 * human role may ever carry it, and no route in this codebase actually
 * guards itself with it via `@RequirePermission` today (svc-attendance
 * calls it a different way, machine-to-machine), but the exemption is
 * asserted by name regardless of whether a decorator currently references
 * it, so this test cannot be "fixed" into failure by a future PR that adds
 * one.
 *
 * `timesheet.totals.read` is the svc-payroll seam fix's own machine-only
 * grant (`roles.ts`'s doc on `PAYROLL_TIMESHEET_TOTALS_READ`) — UNLIKE
 * `biometric.template.read`, it IS currently referenced by a real
 * `@RequirePermission` (`timesheet.controller.ts`'s `periodTotals`), so
 * removing this exemption without also removing that decorator use would
 * correctly fail this test — the exemption only says "zero ROLE_TEMPLATES
 * grants are fine here", not "this permission is unused".
 */
const BIOMETRIC_EXEMPTION = BIOMETRIC_TEMPLATE_READ
const PAYROLL_TOTALS_EXEMPTION = PAYROLL_TIMESHEET_TOTALS_READ
const UNREACHABLE_BY_DESIGN = new Set([BIOMETRIC_EXEMPTION, PAYROLL_TOTALS_EXEMPTION])

/**
 * Every `.ts` file under `services/<name>/src/`, recursively, excluding
 * `.test.ts` files (which may reference permission strings in assertions,
 * not real decorator usage) and `dist`/`node_modules` (build output and
 * dependencies, never source).
 */
function findSourceFiles(): string[] {
  const results: string[] = []
  const serviceDirs = readdirSync(SERVICES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())

  for (const serviceDir of serviceDirs) {
    const srcDir = join(SERVICES_DIR, serviceDir.name, 'src')
    let entries: string[]
    try {
      entries = walk(srcDir)
    } catch {
      continue // no src/ dir — don't let one oddly-shaped service crash the whole gate
    }
    results.push(...entries)
  }
  return results
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      out.push(...walk(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Extracts every permission code from a real `@RequirePermission('code')`
 * decorator use. Deliberately line-anchored (`^@RequirePermission\(...\)$`
 * on the TRIMMED line) rather than a bare substring search: this codebase's
 * own doc comments quote the decorator by name — e.g. `seed/roles.ts`'s own
 * header says `` @RequirePermission('config.rule.read') `` — and those are
 * prose, not code. A real decorator always sits alone on its own line
 * immediately before the class/method it guards; a comment referencing it
 * is always preceded by `*` (JSDoc/block-comment continuation) or embedded
 * mid-sentence. Matching only whole trimmed lines starting with the
 * decorator token, with nothing else on the line, separates the two without
 * needing a real TypeScript parser.
 */
function extractRequiredPermissions(source: string): string[] {
  const codes: string[] = []
  const lineRe = /^@RequirePermission\(\s*(['"])([^'"]+)\1\s*\)$/
  for (const rawLine of source.split('\n')) {
    const match = lineRe.exec(rawLine.trim())
    if (match) {
      const code = match[2]
      if (code !== undefined) codes.push(code)
    }
  }
  return codes
}

function allRequiredPermissions(): Set<string> {
  const codes = new Set<string>()
  for (const filePath of findSourceFiles()) {
    const source = readFileSync(filePath, 'utf8')
    for (const code of extractRequiredPermissions(source)) codes.add(code)
  }
  return codes
}

function allGrantedPermissions(): Set<string> {
  const codes = new Set<string>()
  for (const role of ROLE_TEMPLATES) {
    for (const permission of role.permissions) codes.add(permission)
  }
  return codes
}

describe('Every permission referenced by @RequirePermission is grantable (Task 14c, general form)', () => {
  const required = allRequiredPermissions()
  const granted = allGrantedPermissions()

  it('parser sanity: found at least one real @RequirePermission usage in services/', () => {
    expect(required.size).toBeGreaterThan(0)
  })

  it('parser sanity: the three permissions this task fixes are among the ones actually found in source', () => {
    expect(required.has('notify.notification.read')).toBe(true)
    expect(required.has('notify.notification.update')).toBe(true)
    expect(required.has('document.read')).toBe(true)
  })

  it('every @RequirePermission code (except the two machine-only exemptions) is granted to at least one role template', () => {
    const unreachable = [...required].filter((code) => !UNREACHABLE_BY_DESIGN.has(code) && !granted.has(code)).sort()
    expect(unreachable).toEqual([])
  })

  it('parser sanity: timesheet.totals.read is actually found in source (the exemption is not exempting a dead reference)', () => {
    expect(required.has(PAYROLL_TOTALS_EXEMPTION)).toBe(true)
  })

  it('the biometric.template.read exemption itself is still granted to zero roles — the exemption must not become a loophole', () => {
    expect(granted.has(BIOMETRIC_EXEMPTION)).toBe(false)
  })

  it('the timesheet.totals.read exemption itself is still granted to zero roles — machine-only, never a human role', () => {
    expect(granted.has(PAYROLL_TOTALS_EXEMPTION)).toBe(false)
  })
})
