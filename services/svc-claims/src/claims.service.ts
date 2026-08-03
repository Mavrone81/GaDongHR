import { createHash } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'
import { CryptoClient, cryptoUnavailable, writeOutbox } from '@gadong/kernel'
import { GadongError } from '@gadong/kernel'
import { ClaimTypesRepository } from './claim-types.repository'
import type { ClaimTypeRow } from './claim-types.repository'
import { ApprovalBandsService } from './approval-bands.service'
import { ClaimsRepository } from './claims.repository'
import type { ApprovalDecision, ClaimRow, ReimbursementRoute } from './claims.repository'
import { addDecimal, compareDecimal, multiplyDecimal, roundMoney } from './decimal'
import { buildApprovedForPayrollPayload, buildPaidOffcyclePayload } from './events'
import {
  approverOutsideBand,
  claimNotApproved,
  claimNotFound,
  claimNotPending,
  claimNotRejected,
  claimTypeInactive,
  claimTypeNotFound,
  duplicateReceiptSuspected,
  hardLimitExceeded,
  mileageRateNotConfigured,
  notClaimOwner,
  receiptRequired,
  requiredFieldMissing,
  rejectionReasonRequired,
  routeLocked,
} from './errors'

export interface ReceiptInput {
  /** A plaintext pointer to wherever the receipt bytes already live (an object-storage key, a document-service id, etc.) — supplied by the caller, who uploaded the actual bytes through a separate channel. This service's job (M6-2) is to make sure the POINTER never reaches `claims.receipt.file_ref` unencrypted, not to host the object store itself. */
  fileRef: string
  vatAmount?: string | null
}

export interface SubmitClaimInput {
  employeeId: string
  claimTypeCode: string
  claimDate: string
  vendor: string
  /** Required for every non-mileage type; ignored (and recomputed) for `mileage`. */
  amountThb?: string
  /** Required only for a claim type whose `mileageRate` is configured. */
  mileageKm?: string
  receipts: ReceiptInput[]
  fields?: Record<string, unknown>
}

export interface ResubmitClaimInput {
  claimDate?: string
  vendor?: string
  amountThb?: string
  mileageKm?: string
  receipts?: ReceiptInput[]
  fields?: Record<string, unknown>
}

export interface SubmitClaimResult {
  claim: ClaimRow
  warnings: string[]
}

function validationError(reason: string): GadongError {
  return new GadongError('CLM-017', 'claims.error.validation', 400, [{ reason }])
}

function normaliseVendor(vendor: string): string {
  return vendor.trim().toLowerCase()
}

function computeDupHash(amountThb: string, claimDate: string, vendor: string): string {
  return createHash('sha256').update(`${amountThb}|${claimDate}|${normaliseVendor(vendor)}`).digest('hex')
}

/** `[start, end)` ISO date strings for the calendar month containing `dateStr`. Pure integer arithmetic on the y/m components — this is calendar math, not money, so plain JS numbers are fine here (the house rule "no float touches money" is about amounts, never dates). */
function monthWindow(dateStr: string): [string, string] {
  const [yStr = '', mStr = ''] = dateStr.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const start = `${yStr}-${mStr}-01`
  const nextY = m === 12 ? y + 1 : y
  const nextM = m === 12 ? 1 : m + 1
  return [start, `${String(nextY).padStart(4, '0')}-${String(nextM).padStart(2, '0')}-01`]
}

/** `[start, end)` ISO date strings for the calendar year containing `dateStr`. */
function yearWindow(dateStr: string): [string, string] {
  const y = Number(dateStr.split('-')[0])
  return [`${y}-01-01`, `${y + 1}-01-01`]
}

/**
 * M6-2/M6-3/M6-4/M6-5 business logic — no SQL here (`claims.repository.ts`
 * owns that), matching `services/svc-config`'s `service`/no-SQL split.
 * Every write method takes the CALLER's transaction handle `tx` so the
 * state change and any outbox event it writes commit or roll back together
 * (kernel `writeOutbox`, ADR-005).
 */
export class ClaimsService {
  constructor(
    private readonly repo: ClaimsRepository,
    private readonly claimTypes: ClaimTypesRepository,
    private readonly bands: ApprovalBandsService,
    private readonly crypto: CryptoClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `GET /my/claims` — status visible to the employee end-to-end (M6-4). Read-only, off the injected pool (no transaction needed). */
  async listForEmployee(employeeId: string, status?: string): Promise<ClaimRow[]> {
    return this.repo.listByEmployee(employeeId, status)
  }

  async submit(tx: Queryable, input: SubmitClaimInput): Promise<SubmitClaimResult> {
    const type = await this.loadActiveType(input.claimTypeCode)
    const amountThb = this.resolveAmount(type, input.amountThb, input.mileageKm)
    this.validateRequiredFields(type, input.fields ?? {})
    if (type.receiptRequired && input.receipts.length === 0) throw receiptRequired(type.code)

    const dupHash = computeDupHash(amountThb, input.claimDate, input.vendor)
    const duplicates = await this.repo.findActiveByDupHash(input.employeeId, type.code, dupHash, null)
    if (duplicates.length > 0) throw duplicateReceiptSuspected(dupHash)

    const { softLimitWarning, warnings } = await this.enforceLimits(type, input.employeeId, input.claimDate, amountThb, null)

    const approverRoles = await this.bands.bandsFor(amountThb)

    const vatAmount = this.sumReceiptVat(input.receipts)

    const claim = await this.repo.insert(tx, {
      employeeId: input.employeeId,
      claimType: type.code,
      amountThb,
      status: 'pending',
      dupHash,
      claimDate: input.claimDate,
      vendor: input.vendor,
      mileageKm: input.mileageKm ?? null,
      vatAmount,
      round: 1,
      softLimitWarning,
      submittedAt: this.now().toISOString(),
      fields: input.fields ?? {},
    })

    await this.repo.insertApprovalSteps(tx, claim.id, 1, approverRoles)
    await this.storeReceipts(tx, claim.id, input.receipts)

    return { claim, warnings }
  }

  async resubmit(tx: Queryable, claimId: string, employeeId: string, input: ResubmitClaimInput): Promise<SubmitClaimResult> {
    const existing = await this.repo.findById(claimId)
    if (!existing) throw claimNotFound(claimId)
    if (existing.employeeId !== employeeId) throw notClaimOwner(claimId)
    if (existing.status !== 'rejected') throw claimNotRejected(claimId, existing.status)

    const type = await this.loadActiveType(existing.claimType)
    const claimDate = input.claimDate ?? existing.claimDate ?? this.now().toISOString().slice(0, 10)
    const vendor = input.vendor ?? existing.vendor ?? ''
    const mileageKm = input.mileageKm ?? existing.mileageKm ?? undefined
    const amountThb = this.resolveAmount(type, input.amountThb ?? existing.amountThb, mileageKm)
    const fields = { ...existing.fields, ...(input.fields ?? {}) }
    this.validateRequiredFields(type, fields)

    const receipts = input.receipts ?? []
    const existingReceiptCount = (await this.repo.listReceipts(claimId)).length
    if (type.receiptRequired && existingReceiptCount === 0 && receipts.length === 0) throw receiptRequired(type.code)

    const dupHash = computeDupHash(amountThb, claimDate, vendor)
    const duplicates = await this.repo.findActiveByDupHash(employeeId, type.code, dupHash, claimId)
    if (duplicates.length > 0) throw duplicateReceiptSuspected(dupHash)

    const { softLimitWarning, warnings } = await this.enforceLimits(type, employeeId, claimDate, amountThb, claimId)

    const approverRoles = await this.bands.bandsFor(amountThb)
    const nextRound = existing.round + 1

    const claim = await this.repo.applyResubmission(tx, claimId, {
      amountThb,
      dupHash,
      claimDate,
      vendor,
      mileageKm: mileageKm ?? null,
      vatAmount: existing.vatAmount,
      round: nextRound,
      softLimitWarning,
      fields,
    })

    await this.repo.insertApprovalSteps(tx, claimId, nextRound, approverRoles)
    if (receipts.length > 0) await this.storeReceipts(tx, claimId, receipts)

    return { claim, warnings }
  }

  /** `requiredRole` is which decision route was called (`'manager'` or `'finance'`) — it is what pins the caller's permission (`claim.approve` vs `claim.approve.finance`) to a specific approval level; a decision submitted on the wrong level is CLM-020, not silently accepted. */
  async decide(
    tx: Queryable,
    claimId: string,
    requiredRole: string,
    approverId: string,
    decision: ApprovalDecision,
    comment: string | null,
  ): Promise<ClaimRow> {
    const claim = await this.repo.findById(claimId)
    if (!claim) throw claimNotFound(claimId)
    if (claim.status !== 'pending') throw claimNotPending(claimId, claim.status)

    const steps = await this.repo.listApprovalSteps(claimId, claim.round)
    const pending = steps.find((s) => s.decision === null)
    if (!pending || pending.approverRole !== requiredRole) {
      throw approverOutsideBand(claimId, pending?.approverRole ?? null)
    }

    if (decision === 'rejected') {
      if (!comment || comment.trim().length === 0) throw rejectionReasonRequired(claimId)
      await this.repo.decideStep(tx, pending.id, approverId, 'rejected', comment)
      return this.repo.markRejected(tx, claimId, comment)
    }

    await this.repo.decideStep(tx, pending.id, approverId, 'approved', comment)
    const isFinalLevel = pending.level === steps.length
    if (isFinalLevel) return this.repo.markApproved(tx, claimId)
    return claim
  }

  async route(tx: Queryable, claimId: string, route: ReimbursementRoute): Promise<ClaimRow> {
    const claim = await this.repo.findById(claimId)
    if (!claim) throw claimNotFound(claimId)
    if (claim.status === 'for_payroll' || claim.status === 'paid_offcycle') {
      throw routeLocked(claimId, claim.status)
    }
    if (claim.status !== 'approved') throw claimNotApproved(claimId, claim.status)

    const updated = await this.repo.route(tx, claimId, route)

    if (route === 'payroll') {
      await writeOutbox(tx, 'claims', 'claim.approved_for_payroll', buildApprovedForPayrollPayload(updated))
    } else {
      await writeOutbox(tx, 'claims', 'claim.paid_offcycle', buildPaidOffcyclePayload(updated))
    }

    return updated
  }

  private async loadActiveType(code: string): Promise<ClaimTypeRow> {
    const type = await this.claimTypes.findByCode(code)
    if (!type) throw claimTypeNotFound(code)
    if (!type.active) throw claimTypeInactive(code)
    return type
  }

  private resolveAmount(type: ClaimTypeRow, amountThb: string | undefined, mileageKm: string | undefined): string {
    if (mileageKm !== undefined) {
      if (type.mileageRate === null) throw mileageRateNotConfigured(type.code)
      return roundMoney(multiplyDecimal(mileageKm, type.mileageRate))
    }
    if (amountThb === undefined) throw validationError('amountThb is required for a non-mileage claim')
    return amountThb
  }

  private validateRequiredFields(type: ClaimTypeRow, fields: Record<string, unknown>): void {
    for (const field of type.requiredFields) {
      const value = fields[field]
      if (value === undefined || value === null || value === '') throw requiredFieldMissing(field)
    }
  }

  private sumReceiptVat(receipts: ReceiptInput[]): string | null {
    const amounts = receipts.map((r) => r.vatAmount).filter((v): v is string => v !== undefined && v !== null)
    if (amounts.length === 0) return null
    return amounts.reduce((acc, v) => addDecimal(acc, v), '0')
  }

  private async storeReceipts(tx: Queryable, claimId: string, receipts: ReceiptInput[]): Promise<void> {
    for (const receipt of receipts) {
      const ciphertexts = await this.crypto.encryptBatch([
        { entityId: claimId, field: 'file_ref', value: receipt.fileRef, fieldClass: 'S3' },
      ])
      const fileRef = ciphertexts.get('file_ref')
      // encryptBatch never returns successfully with a requested field
      // missing (kernel CryptoClient's contract) — defensive, not a real path.
      if (!fileRef) throw cryptoUnavailable()
      await this.repo.insertReceipt(tx, claimId, fileRef, receipt.vatAmount ?? null)
    }
  }

  /**
   * M6-5: per-claim, monthly and annual limit enforcement, each
   * independently hard or soft per the claim type's config. A HARD breach
   * at any tier throws immediately (CLM-010) and nothing is written. A SOFT
   * breach at any tier does not block — it accumulates into `warnings` and
   * sets `softLimitWarning: true` so the claim proceeds but is flagged for
   * approver attention (module doc §1.1: "Flag for approver attention").
   * `excludeClaimId` lets a resubmission recompute its own monthly/annual
   * usage without double-counting its own prior amount.
   */
  private async enforceLimits(
    type: ClaimTypeRow,
    employeeId: string,
    claimDate: string,
    amountThb: string,
    excludeClaimId: string | null,
  ): Promise<{ softLimitWarning: boolean; warnings: string[] }> {
    const warnings: string[] = []
    let softLimitWarning = false

    const checkTier = (tier: 'per_claim' | 'monthly' | 'annual', attempted: string, limit: string | null, kind: 'hard' | 'soft' | null) => {
      if (limit === null || kind === null) return
      if (compareDecimal(attempted, limit) <= 0) return
      if (kind === 'hard') throw hardLimitExceeded(tier, limit, attempted)
      softLimitWarning = true
      warnings.push(`${tier} soft limit exceeded: attempted ${attempted}, limit ${limit}`)
    }

    checkTier('per_claim', amountThb, type.perClaimLimit, type.perClaimLimitKind)

    if (type.monthlyLimit !== null) {
      const [monthStart, monthEnd] = monthWindow(claimDate)
      const priorMonthUsage = (await this.repo.sumActiveAmount(employeeId, type.code, monthStart, monthEnd, excludeClaimId)) ?? '0'
      const projectedMonth = addDecimal(priorMonthUsage, amountThb)
      checkTier('monthly', projectedMonth, type.monthlyLimit, type.monthlyLimitKind)
    }

    if (type.annualLimit !== null) {
      const [yearStart, yearEnd] = yearWindow(claimDate)
      const priorYearUsage = (await this.repo.sumActiveAmount(employeeId, type.code, yearStart, yearEnd, excludeClaimId)) ?? '0'
      const projectedYear = addDecimal(priorYearUsage, amountThb)
      checkTier('annual', projectedYear, type.annualLimit, type.annualLimitKind)
    }

    return { softLimitWarning, warnings }
  }
}
