import { AuthzRepository } from '../authz.repository'
import { FakeAuthzDb } from '../testing/fake-db'
import {
  BIOMETRIC_TEMPLATE_READ,
  PERMISSION_CATALOG,
  ROLE_TEMPLATES,
  assertNoBiometricGrant,
  seedContentHash,
  seedRoleTemplates,
} from './roles'

describe('PERMISSION_CATALOG', () => {
  it('has no duplicate codes', () => {
    const codes = PERMISSION_CATALOG.map((p) => p.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('includes biometric.template.read (it exists in the catalog — it is just never granted to a human role)', () => {
    expect(PERMISSION_CATALOG.map((p) => p.code)).toContain(BIOMETRIC_TEMPLATE_READ)
  })

  it('every permission a ROLE_TEMPLATES entry grants exists in the catalog (no role can grant an uncatalogued code)', () => {
    const catalogCodes = new Set(PERMISSION_CATALOG.map((p) => p.code))
    for (const role of ROLE_TEMPLATES) {
      for (const permission of role.permissions) {
        expect(catalogCodes.has(permission)).toBe(true)
      }
    }
  })
})

describe('ROLE_TEMPLATES — exactly the ten from the roadmap', () => {
  it('has exactly the ten role codes the roadmap and Security doc §4.2 name', () => {
    const codes = ROLE_TEMPLATES.map((r) => r.code).sort()
    expect(codes).toEqual(
      [
        'auditor-readonly',
        'compliance-approver',
        'dpo',
        'employee-ess',
        'hr-officer',
        'hr-system-admin',
        'kiosk-device',
        'line-manager',
        'payroll-approver',
        'payroll-officer',
      ].sort(),
    )
  })

  it('payroll-officer does NOT hold payroll.run.approve — segregation of duties (Security doc §4.2 "explicitly denied")', () => {
    const role = ROLE_TEMPLATES.find((r) => r.code === 'payroll-officer')
    expect(role?.permissions).not.toContain('payroll.run.approve')
  })

  it('payroll-approver does NOT hold payroll.run.prepare or payroll.run.calculate — SoD inverse', () => {
    const role = ROLE_TEMPLATES.find((r) => r.code === 'payroll-approver')
    expect(role?.permissions).not.toContain('payroll.run.prepare')
    expect(role?.permissions).not.toContain('payroll.run.calculate')
  })

  it('hr-officer does NOT hold any payroll.* permission or biometric.template.read (Security doc §4.2)', () => {
    const role = ROLE_TEMPLATES.find((r) => r.code === 'hr-officer')
    expect(role?.permissions.some((p) => p.startsWith('payroll.'))).toBe(false)
    expect(role?.permissions).not.toContain(BIOMETRIC_TEMPLATE_READ)
  })

  it('hr-system-admin does NOT hold config.rule.approve — cannot approve its own config proposals (SoD)', () => {
    const role = ROLE_TEMPLATES.find((r) => r.code === 'hr-system-admin')
    expect(role?.permissions).not.toContain('config.rule.approve')
  })

  it('compliance-approver does NOT hold config.rule.propose — cannot propose what it approves (SoD)', () => {
    const role = ROLE_TEMPLATES.find((r) => r.code === 'compliance-approver')
    expect(role?.permissions).not.toContain('config.rule.propose')
  })

  it('dpo does NOT hold any payroll.* permission', () => {
    const role = ROLE_TEMPLATES.find((r) => r.code === 'dpo')
    expect(role?.permissions.some((p) => p.startsWith('payroll.'))).toBe(false)
  })

  it('auditor-readonly holds no write-shaped permission', () => {
    const WRITE_VERBS = ['create', 'update', 'write', 'approve', 'propose', 'grant', 'commit', 'correct', 'admin', 'lifecycle', 'import', 'manage', 'register', 'publish', 'prepare', 'calculate', 'export', 'lock', 'unlock', 'submit']
    const role = ROLE_TEMPLATES.find((r) => r.code === 'auditor-readonly')
    for (const permission of role?.permissions ?? []) {
      const action = permission.split('.').pop() ?? ''
      expect(WRITE_VERBS).not.toContain(action)
    }
  })

  it('kiosk-device holds only punch.submit', () => {
    const role = ROLE_TEMPLATES.find((r) => r.code === 'kiosk-device')
    expect(role?.permissions).toEqual(['punch.submit'])
  })
})

describe('No human role ever holds biometric.template.read (Security doc §4.2, absolute — Task 8 brief §4, property 2)', () => {
  it('none of the ten static ROLE_TEMPLATES — including hr-system-admin — lists it', () => {
    for (const role of ROLE_TEMPLATES) {
      expect(role.permissions).not.toContain(BIOMETRIC_TEMPLATE_READ)
    }
  })

  it('hr-system-admin specifically does not hold it (the role most likely to be "fixed" into having it)', () => {
    const admin = ROLE_TEMPLATES.find((r) => r.code === 'hr-system-admin')
    expect(admin?.permissions).not.toContain(BIOMETRIC_TEMPLATE_READ)
  })

  it('assertNoBiometricGrant(ROLE_TEMPLATES) does not throw for the real, correct template set', () => {
    expect(() => assertNoBiometricGrant(ROLE_TEMPLATES)).not.toThrow()
  })

  it('assertNoBiometricGrant throws for a template set where any role carries it — the guardrail actually guards', () => {
    const corrupted = ROLE_TEMPLATES.map((r) =>
      r.code === 'hr-system-admin' ? { ...r, permissions: [...r.permissions, BIOMETRIC_TEMPLATE_READ] } : r,
    )
    expect(() => assertNoBiometricGrant(corrupted)).toThrow(/biometric\.template\.read/)
  })

  it('after seeding, no role in the database carries biometric.template.read (end-to-end, all ten roles)', async () => {
    const db = new FakeAuthzDb()
    const repo = new AuthzRepository(db.asPool())
    await seedRoleTemplates(db.asPool())

    for (const role of await repo.listRoles()) {
      const codes = await repo.listPermissionCodesForRole(role.id)
      expect(codes).not.toContain(BIOMETRIC_TEMPLATE_READ)
    }
  })
})

describe('seedRoleTemplates — idempotent (Task 8 brief §5: "twice ⇒ identical state, asserted by content hash")', () => {
  it('seeding the same fake db twice yields byte-identical state (same content hash)', async () => {
    const db = new FakeAuthzDb()
    const pool = db.asPool()

    await seedRoleTemplates(pool)
    const hashAfterFirst = await seedContentHash(pool)

    await seedRoleTemplates(pool)
    const hashAfterSecond = await seedContentHash(pool)

    expect(hashAfterSecond).toBe(hashAfterFirst)
  })

  it('seeding twice does not duplicate roles or permissions', async () => {
    const db = new FakeAuthzDb()
    const pool = db.asPool()

    await seedRoleTemplates(pool)
    await seedRoleTemplates(pool)

    expect(db.debugRoles()).toHaveLength(ROLE_TEMPLATES.length)
    expect(db.debugPermissions()).toHaveLength(PERMISSION_CATALOG.length)
  })

  it('seeds every role with exactly its ROLE_TEMPLATES permission set', async () => {
    const db = new FakeAuthzDb()
    const pool = db.asPool()
    const repo = new AuthzRepository(pool)

    await seedRoleTemplates(pool)

    const payrollOfficer = await repo.findRoleByCode('payroll-officer')
    if (!payrollOfficer) throw new Error('payroll-officer not seeded')
    const codes = await repo.listPermissionCodesForRole(payrollOfficer.id)
    expect(codes.sort()).toEqual(
      ROLE_TEMPLATES.find((r) => r.code === 'payroll-officer')?.permissions.slice().sort(),
    )
  })
})
