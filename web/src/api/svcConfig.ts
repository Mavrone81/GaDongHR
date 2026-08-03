import { useMemo } from 'react'
import { loadConfig } from '../env'
import { createApiClient } from './httpClient'
import type { ApiClient, AuthTokenSource } from './httpClient'
import { useAuth } from '../auth/AuthContext'

/**
 * Wire types mirroring `services/svc-config/src/rules.repository.ts`'s
 * `StatutoryRuleRow`/`GovernanceClass`/`RuleStatus` and
 * `rules.service.ts`'s `ProposeRuleInput`. Duplicated deliberately, not
 * imported — `services/svc-config` is out of `web`'s ownership (task
 * brief: "do not modify services"), and importing server-only source into
 * a browser bundle is exactly the trap `packages/kernel`'s own barrel
 * export would set (Nest/`pg` decorators, see `env.ts`'s neighbours for
 * why this app only ever imports `@gadong/kernel/dist/i18n/format`
 * directly). This is the HTTP contract, kept in sync by hand.
 */
export type GovernanceClass = 'STATUTORY_FLOOR' | 'STATUTORY_FIXED' | 'COMPANY_POLICY'
export type RuleStatus = 'draft' | 'pending_approval' | 'active' | 'superseded'

export interface StatutoryRuleRow {
  id: string
  ruleKey: string
  value: unknown
  unit: string
  statutoryFloor: unknown
  statutoryCeiling: unknown
  citation: string
  effectiveFrom: string
  effectiveTo: string | null
  governanceClass: GovernanceClass
  status: RuleStatus
  proposedBy: string | null
  approvedBy: string | null
  reason: string | null
  createdAt: string
}

export interface ProposeRuleInput {
  ruleKey: string
  value: unknown
  unit: string
  statutoryFloor?: unknown
  statutoryCeiling?: unknown
  citation: string
  effectiveFrom: string
  effectiveTo?: string | null
  governanceClass: GovernanceClass
  reason: string
  proposedBy: string
}

export interface SvcConfigClient {
  listRules(prefix?: string): Promise<StatutoryRuleRow[]>
  getRule(key: string, on?: string): Promise<StatutoryRuleRow>
  proposeRule(input: ProposeRuleInput): Promise<StatutoryRuleRow>
  approveRule(id: string, approvedBy: string): Promise<StatutoryRuleRow>
}

export function createSvcConfigClient(baseUrl: string, tokens: AuthTokenSource): SvcConfigClient {
  const client: ApiClient = createApiClient(baseUrl, tokens)
  return {
    async listRules(prefix) {
      const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
      const res = await client.request<{ rules: StatutoryRuleRow[] }>(`/rules${query}`)
      return res.rules
    },
    async getRule(key, on) {
      const query = on ? `?on=${encodeURIComponent(on)}` : ''
      return client.request<StatutoryRuleRow>(`/rules/${encodeURIComponent(key)}${query}`)
    },
    async proposeRule(input) {
      return client.request<StatutoryRuleRow>('/rules', { method: 'POST', body: JSON.stringify(input) })
    },
    async approveRule(id, approvedBy) {
      return client.request<StatutoryRuleRow>(`/rules/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvedBy }),
      })
    },
  }
}

export function useSvcConfig(): SvcConfigClient {
  const { tokenSource } = useAuth()
  const baseUrl = useMemo(() => loadConfig().svcConfigUrl, [])
  return useMemo(() => createSvcConfigClient(baseUrl, tokenSource), [baseUrl, tokenSource])
}
