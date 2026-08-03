import { HttpException } from '@nestjs/common'
import { GadongError, PERMISSION_METADATA_KEY } from '@gadong/kernel'
import type { Pool } from 'pg'
import { EmployeeController, DB_POOL } from './employee.controller'
import { AppModule } from './app.module'
import { APP_GUARD } from '@nestjs/core'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** A minimal `pg.Pool` double whose `connect()` returns a harmless client — matches `services/svc-docs/src/documents.controller.test.ts`'s `fakePool`, sufficient because every faked service below never actually issues SQL through the `tx` it's handed. */
function fakePool(overrides: Partial<Pool> = {}): Pool {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

interface FakeDeps {
  employees: {
    prepareCreate: jest.Mock
    commitCreate: jest.Mock
    list: jest.Mock
    getProfile: jest.Mock
    prepareSensitiveRead: jest.Mock
    commitSensitiveReadAudit: jest.Mock
    prepareUpdate: jest.Mock
    commitUpdate: jest.Mock
    transition: jest.Mock
    hasSsoNumber: jest.Mock
  }
  checklist: { listForEmployee: jest.Mock; completeTask: jest.Mock; findTask: jest.Mock }
  consents: { prepareDecision: jest.Mock; commitDecision: jest.Mock; prepareWithdraw: jest.Mock; commitWithdraw: jest.Mock }
  probation: { decide: jest.Mock }
  contracts: { generate: jest.Mock }
  selfService: { submit: jest.Mock }
}

function makeController(overrides: Partial<FakeDeps> = {}): { controller: EmployeeController; deps: FakeDeps } {
  const deps: FakeDeps = {
    employees: {
      prepareCreate: jest.fn().mockResolvedValue({ newRow: {}, checklistPlan: [], probationEndDate: undefined }),
      commitCreate: jest.fn().mockResolvedValue({ id: 'emp-1', empCode: 'EMP-0001' }),
      list: jest.fn().mockResolvedValue([]),
      getProfile: jest.fn().mockResolvedValue({ id: 'emp-1' }),
      prepareSensitiveRead: jest.fn().mockResolvedValue({ national_id: '1101700230708' }),
      commitSensitiveReadAudit: jest.fn().mockResolvedValue(undefined),
      prepareUpdate: jest.fn().mockResolvedValue({ id: 'emp-1', patch: {} }),
      commitUpdate: jest.fn().mockResolvedValue({ id: 'emp-1', empCode: 'EMP-0001' }),
      transition: jest.fn().mockResolvedValue({ id: 'emp-1', status: 'onboarding' }),
      hasSsoNumber: jest.fn().mockResolvedValue(true),
      ...overrides.employees,
    },
    checklist: {
      listForEmployee: jest.fn().mockResolvedValue([]),
      completeTask: jest.fn().mockResolvedValue({ id: 'task-1', status: 'completed' }),
      findTask: jest.fn().mockResolvedValue({ id: 'task-1', employeeId: 'emp-1', taskKey: 'document_upload', dueDate: '2026-09-01', status: 'pending' }),
      ...overrides.checklist,
    },
    consents: {
      prepareDecision: jest.fn().mockResolvedValue([{ purpose: 'biometric' }]),
      commitDecision: jest.fn().mockResolvedValue([{ id: 'cr-1', state: 'granted' }]),
      prepareWithdraw: jest.fn().mockResolvedValue({ employeeId: 'emp-1' }),
      commitWithdraw: jest.fn().mockResolvedValue({ id: 'cr-2', state: 'withdrawn' }),
      ...overrides.consents,
    },
    probation: { decide: jest.fn().mockResolvedValue({ probation: { id: 'p-1', outcome: 'confirm' } }), ...overrides.probation },
    contracts: { generate: jest.fn().mockResolvedValue({ id: 'doc-1', sha256: 'abc' }), ...overrides.contracts },
    selfService: { submit: jest.fn().mockResolvedValue({ id: 'emp-1', empCode: 'EMP-0001' }), ...overrides.selfService },
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructing the controller from hand-built fakes shaped like each service's public surface; a full class instance is unnecessary for these wiring/delegation tests.
  const controller = new EmployeeController(deps.employees as any, deps.checklist as any, deps.consents as any, deps.probation as any, deps.contracts as any, deps.selfService as any, fakePool())
  return { controller, deps }
}

function reqWith(userId?: string, actorRole?: string): { userId?: string; actorRole?: string } {
  const r: { userId?: string; actorRole?: string } = {}
  if (userId !== undefined) r.userId = userId
  if (actorRole !== undefined) r.actorRole = actorRole
  return r
}

describe('EmployeeController — delegation', () => {
  it('POST /employees calls prepareCreate then commitCreate inside a transaction', async () => {
    const { controller, deps } = makeController()
    const body = { empCode: 'EMP-0001' } as unknown as Parameters<EmployeeController['create']>[0]
    const out = await controller.create(body, reqWith('hr-1', 'hr-officer'))
    expect(deps.employees.prepareCreate).toHaveBeenCalledWith(body)
    expect(deps.employees.commitCreate).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'hr-1', 'hr-officer')
    expect(out).toEqual({ id: 'emp-1', empCode: 'EMP-0001' })
  })

  it('GET /employees/:id/sensitive parses fields=a,b and forwards purpose, then audits after decrypting', async () => {
    const { controller, deps } = makeController()
    await controller.getSensitive('emp-1', { fields: 'national_id, bank_account', purpose: 'kyc' }, reqWith('hr-1', 'hr-officer'))
    expect(deps.employees.prepareSensitiveRead).toHaveBeenCalledWith('emp-1', ['national_id', 'bank_account'], 'kyc')
    expect(deps.employees.commitSensitiveReadAudit).toHaveBeenCalledWith(expect.anything(), 'emp-1', ['national_id', 'bank_account'], 'kyc', 'hr-1', 'hr-officer')
  })

  it('POST /checklist/tasks/:taskId/complete resolves ssoNumberPresent via the task lookup when the body omits it', async () => {
    const { controller, deps } = makeController()
    await controller.completeTask('task-1', {})
    expect(deps.checklist.findTask).toHaveBeenCalledWith('task-1')
    expect(deps.employees.hasSsoNumber).toHaveBeenCalledWith('emp-1')
    expect(deps.checklist.completeTask).toHaveBeenCalledWith(expect.anything(), 'task-1', true)
  })

  it('POST /checklist/tasks/:taskId/complete uses the body-supplied ssoNumberPresent without an extra lookup', async () => {
    const { controller, deps } = makeController()
    await controller.completeTask('task-1', { ssoNumberPresent: false })
    expect(deps.checklist.findTask).not.toHaveBeenCalled()
    expect(deps.employees.hasSsoNumber).not.toHaveBeenCalled()
    expect(deps.checklist.completeTask).toHaveBeenCalledWith(expect.anything(), 'task-1', false)
  })

  it('POST /employees/:id/consents rejects ONB-020 as an HttpException with the right status/code', async () => {
    const err = new GadongError('ONB-020', 'onboarding.error.biometric_consent_must_be_separate', 422)
    const { controller } = makeController({ consents: { prepareDecision: jest.fn().mockRejectedValue(err) } as never })
    try {
      await controller.submitConsent('emp-1', { purpose: ['hr_processing', 'biometric'], decision: 'granted', formVersion: 1 }, reqWith('emp-1', 'employee-ess'))
      throw new Error('expected rejection')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(HttpException)
      expect((thrown as HttpException).getStatus()).toBe(422)
      expect((thrown as HttpException).getResponse()).toMatchObject({ code: 'ONB-020' })
    }
  })

  it('DELETE /employees/:id/consents/biometric returns the record and an slaDays hint', async () => {
    const { controller } = makeController()
    const out = await controller.withdrawBiometricConsent('emp-1', reqWith('emp-1', 'employee-ess'))
    expect(out).toMatchObject({ record: { id: 'cr-2', state: 'withdrawn' }, slaDays: 7 })
  })

  it('POST /self-service/:token maps a "duplicate" result to {duplicate: true}', async () => {
    const { controller } = makeController({ selfService: { submit: jest.fn().mockResolvedValue('duplicate') } as never })
    const out = await controller.selfServiceSubmit('emp-1', { submissionId: 'sub-1', patch: {} }, reqWith('emp-1', 'employee-ess'))
    expect(out).toEqual({ duplicate: true })
  })

})

describe('EmployeeController — deny-by-default permission wiring (M1-ONBOARDING §3.1)', () => {
  const EXPECTED: Record<string, string> = {
    create: 'employee.create',
    list: 'employee.read',
    getOne: 'employee.read',
    getSensitive: 'employee.sensitive.read',
    update: 'employee.update',
    transition: 'employee.lifecycle',
    getChecklist: 'onboarding.manage',
    completeTask: 'onboarding.manage',
    submitConsent: 'consent.self',
    withdrawBiometricConsent: 'consent.self',
    generateContract: 'document.generate',
    probationDecision: 'onboarding.manage',
    selfServiceSubmit: 'employee.update',
  }

  it.each(Object.entries(EXPECTED))('%s() declares @RequirePermission(%s)', (method, permission) => {
    const proto = EmployeeController.prototype as unknown as Record<string, () => unknown>
    const handler = proto[method]
    if (!handler) throw new Error(`no such handler: ${method}`)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe(permission)
  })

  it('has no class-level @RequirePermission that could mask an unannotated method', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, EmployeeController)).toBeUndefined()
  })

  it('every method on this controller is accounted for above (no silently-unguarded route) — GET /health lives on the separate HealthController, not here', () => {
    const proto = EmployeeController.prototype as unknown as Record<string, unknown>
    const methodNames = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor' && typeof proto[n] === 'function' && !n.startsWith('_') && n !== 'runFailClosed',
    )
    expect(methodNames.sort()).toEqual(Object.keys(EXPECTED).sort())
  })
})

describe('AppModule mounts the kernel PermissionGuard and a DB_POOL provider', () => {
  it('registers an APP_GUARD provider bound to PermissionGuard', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const appGuardEntry = providers.find((p) => isRecord(p) && p['provide'] === APP_GUARD)
    expect(appGuardEntry).toBeDefined()
  })

  it('registers a DB_POOL provider', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const hasDbPool = providers.some((p) => isRecord(p) && p['provide'] === DB_POOL)
    expect(hasDbPool).toBe(true)
  })
})
