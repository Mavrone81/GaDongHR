import { useMemo } from 'react'
import { loadConfig } from '../env'
import { createApiClient } from './httpClient'
import type { ApiClient, AuthTokenSource } from './httpClient'
import { useAuth } from '../auth/AuthContext'

/**
 * Wire types mirroring `services/svc-onboarding/src`'s
 * `CreateEmployeeInput` / `EmployeeSummary` / `EmployeeProfile`
 * (employee.service.ts), `ConsentDecisionInput` (consent.service.ts) and
 * the checklist rows. Duplicated by hand rather than imported, for the
 * same reason `svcConfig.ts` states: `services/*` is server-only source
 * and pulling it into a browser bundle drags Nest and `pg` with it.
 */
export type EmploymentType = 'monthly' | 'daily' | 'hourly' | 'contract'
export type EmployeeStatus = 'probation' | 'active' | 'suspended' | 'terminated'
export type Lang = 'th' | 'en' | 'zh'

export interface ThaiAddress {
  houseNo: string
  subDistrict: string
  district: string
  province: string
  postalCode: string
}

export interface EmployeeSummary {
  id: string
  empCode: string
  employmentType: EmploymentType
  orgUnitId: string
  positionId: string
  provinceCode: string
  startDate: string
  status: EmployeeStatus
  preferredLang: Lang
}

export interface EmployeeProfile extends EmployeeSummary {
  firstNameTh: string
  lastNameTh: string
  firstNameEn: string
  lastNameEn: string
  nameZh: string | null
  dob: string
  address: ThaiAddress
  phone: string
  email: string
  terminationDate: string | null
  clockInMethod: string
  createdAt: string
  updatedAt: string
}

export interface CreateEmployeeInput {
  empCode: string
  firstNameTh: string
  lastNameTh: string
  firstNameEn: string
  lastNameEn: string
  nameZh?: string
  nationalId: string
  passportNo?: string
  taxId: string
  /** Blank means "not yet registered with SSO" — the server blocks the `sso_registration` checklist task until this is a real value (ONB-030). */
  ssoNumber?: string
  bankAccount: string
  bankCode: string
  dob: string
  address: ThaiAddress
  phone: string
  email: string
  employmentType: EmploymentType
  orgUnitId: string
  positionId: string
  provinceCode: string
  startDate: string
  preferredLang: Lang
  probationEndDate?: string
}

/**
 * PDPA-BIOMETRIC-COMPLIANCE.md §4.1: biometric consent must be a SEPARATE
 * submission from the general HR-processing notice. Bundling `'biometric'`
 * with any other purpose in one array is rejected server-side as `ONB-020`
 * before anything else is checked — so the UI submits them as two distinct
 * decisions and never offers a combined control.
 */
export interface ConsentDecisionInput {
  purpose: string | string[]
  decision: 'granted' | 'refused'
  formVersion: number
}

export interface ConsentRecord {
  id: string
  employeeId: string
  purpose: string
  decision: 'granted' | 'refused'
  formVersion: number
  decidedAt: string
}

export interface ChecklistTask {
  id: string
  employeeId: string
  taskCode: string
  status: string
  dueDate: string | null
  completedAt: string | null
  escalated?: boolean
}

export interface SvcOnboardingClient {
  listEmployees(filter?: { orgUnit?: string; status?: EmployeeStatus }): Promise<EmployeeSummary[]>
  getEmployee(id: string): Promise<EmployeeProfile>
  createEmployee(input: CreateEmployeeInput): Promise<{ id: string; empCode: string }>
  submitConsent(employeeId: string, input: ConsentDecisionInput): Promise<{ records: ConsentRecord[] }>
  getChecklist(employeeId: string): Promise<ChecklistTask[]>
  completeTask(taskId: string, completedBy: string): Promise<{ id: string; status: string }>
}

export function createSvcOnboardingClient(baseUrl: string, tokens: AuthTokenSource): SvcOnboardingClient {
  const api: ApiClient = createApiClient(baseUrl, tokens)
  return {
    async listEmployees(filter) {
      const params = new URLSearchParams()
      if (filter?.orgUnit) params.set('org_unit', filter.orgUnit)
      if (filter?.status) params.set('status', filter.status)
      const query = params.toString()
      const body = await api.request<{ employees: EmployeeSummary[] }>(`employees${query ? `?${query}` : ''}`)
      // Validated rather than cast: a 200 whose body is not the documented
      // shape must render as "no employees", not crash the screen mid-list.
      return Array.isArray(body.employees) ? body.employees : []
    },
    getEmployee(id) {
      return api.request<EmployeeProfile>(`employees/${encodeURIComponent(id)}`)
    },
    createEmployee(input) {
      return api.request<{ id: string; empCode: string }>('employees', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
    },
    submitConsent(employeeId, input) {
      return api.request<{ records: ConsentRecord[] }>(`employees/${encodeURIComponent(employeeId)}/consents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
    },
    async getChecklist(employeeId) {
      const body = await api.request<{ tasks: ChecklistTask[] }>(`employees/${encodeURIComponent(employeeId)}/checklist`)
      return Array.isArray(body.tasks) ? body.tasks : []
    },
    completeTask(taskId, completedBy) {
      return api.request<{ id: string; status: string }>(`checklist/tasks/${encodeURIComponent(taskId)}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completedBy }),
      })
    },
  }
}

export function useSvcOnboarding(): SvcOnboardingClient {
  const { tokenSource } = useAuth()
  const baseUrl = useMemo(() => loadConfig().svcOnboardingUrl, [])
  return useMemo(() => createSvcOnboardingClient(baseUrl, tokenSource), [baseUrl, tokenSource])
}
