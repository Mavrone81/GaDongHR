import type { Queryable } from '@gadong/kernel'
import { compareDecimal } from './decimal'
import { ApprovalBandsRepository } from './approval-bands.repository'
import type { ApprovalBandRow, NewApprovalBandRow } from './approval-bands.repository'
import { invalidApprovalBandConfig } from './errors'

/**
 * M6-3's banding logic — "the band thresholds come from config, never in
 * code" (Task 14 brief). `bandsFor` reads `claims.approval_band` (via the
 * repository) fresh on every call; there is no threshold constant anywhere
 * in this class. `approval-bands.service.test.ts` proves the property
 * directly: change a band's `maxAmount` through `replace()`, call
 * `bandsFor()` again with the SAME amount, and the answer changes.
 */
export class ApprovalBandsService {
  constructor(private readonly repo: ApprovalBandsRepository) {}

  async list(): Promise<ApprovalBandRow[]> {
    return this.repo.list()
  }

  /** Ordered approver roles (one per approval level) for `amountThb` — the first configured band, in ascending `sortOrder`, whose `maxAmount` is NULL (no ceiling) or >= the amount. */
  async bandsFor(amountThb: string): Promise<string[]> {
    const bands = await this.repo.list()
    if (bands.length === 0) {
      throw invalidApprovalBandConfig('no approval bands configured — every claim needs at least one')
    }
    for (const band of bands) {
      if (band.maxAmount === null || compareDecimal(amountThb, band.maxAmount) <= 0) {
        return band.approverRoles
      }
    }
    // Every band had a ceiling and none covered `amountThb` — config gap
    // (the top band should always have maxAmount: null). Fail loudly rather
    // than silently under-banding a large claim.
    throw invalidApprovalBandConfig(`no configured band covers amount ${amountThb} — the top band must have maxAmount: null`)
  }

  /** `PUT /approval-bands` — replaces the whole config. Validates: at least one band, sort_order 0..n-1 with no gaps/duplicates once sorted, ascending max_amount, exactly one (the last) band with maxAmount: null, and every band names at least one approver role. */
  async replace(tx: Queryable, bands: NewApprovalBandRow[]): Promise<ApprovalBandRow[]> {
    if (bands.length === 0) throw invalidApprovalBandConfig('at least one band is required')

    const sorted = [...bands].sort((a, b) => a.sortOrder - b.sortOrder)
    for (const band of sorted) {
      if (band.approverRoles.length === 0) throw invalidApprovalBandConfig('every band requires at least one approver role')
    }
    for (let i = 0; i < sorted.length; i++) {
      const expectedOrder = i + 1
      if (sorted[i]?.sortOrder !== expectedOrder) {
        throw invalidApprovalBandConfig(`sortOrder must be a contiguous 1..n sequence — expected ${expectedOrder}`)
      }
    }
    const last = sorted[sorted.length - 1]
    if (last === undefined || last.maxAmount !== null) {
      throw invalidApprovalBandConfig('the highest band must have maxAmount: null (no ceiling)')
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i]
      const next = sorted[i + 1]
      if (current?.maxAmount === null || current === undefined || next === undefined || next.maxAmount === null) continue
      if (compareDecimal(current.maxAmount, next.maxAmount) >= 0) {
        throw invalidApprovalBandConfig('band maxAmount must strictly increase by sortOrder')
      }
    }

    return this.repo.replaceAll(tx, sorted)
  }
}
