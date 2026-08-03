import type { Queryable } from '@gadong/kernel'
import { GadongError } from '@gadong/kernel'
import { ClaimTypesRepository } from './claim-types.repository'
import type { ClaimTypeRow, LimitKind, NewClaimTypeRow } from './claim-types.repository'
import { claimTypeNotFound } from './errors'

export interface ClaimTypeInput {
  code: string
  name: string
  perClaimLimit?: string | null
  perClaimLimitKind?: LimitKind | null
  monthlyLimit?: string | null
  monthlyLimitKind?: LimitKind | null
  annualLimit?: string | null
  annualLimitKind?: LimitKind | null
  receiptRequired: boolean
  requiredFields?: string[]
  mileageRate?: string | null
  active?: boolean
}

function invalidType(reason: string): GadongError {
  return new GadongError('CLM-016', 'claims.error.invalid_claim_type_config', 400, [{ reason }])
}

/**
 * M6-1 business logic behind `GET/POST /types`, `PATCH /types/:id` — no SQL
 * here (`claim-types.repository.ts` owns that). The one rule enforced at
 * this layer that the DB schema cannot express on its own: a `mileage`-kind
 * type must carry a `mileageRate` before it can be active, because
 * `claims.service.ts` derives `amount_thb` from `distance x rate` and a
 * missing rate would otherwise surface as a confusing failure deep inside
 * submission instead of at config time.
 */
export class ClaimTypesService {
  constructor(private readonly repo: ClaimTypesRepository) {}

  async list(): Promise<ClaimTypeRow[]> {
    return this.repo.list()
  }

  async get(code: string): Promise<ClaimTypeRow> {
    const row = await this.repo.findByCode(code)
    if (!row) throw claimTypeNotFound(code)
    return row
  }

  async create(tx: Queryable, input: ClaimTypeInput): Promise<ClaimTypeRow> {
    const row = this.toNewRow(input)
    this.validate(row)
    return this.repo.insert(tx, row)
  }

  async update(tx: Queryable, code: string, input: Omit<ClaimTypeInput, 'code'>): Promise<ClaimTypeRow> {
    const row = this.toNewRow({ ...input, code })
    this.validate(row)
    const updated = await this.repo.update(tx, code, row)
    if (!updated) throw claimTypeNotFound(code)
    return updated
  }

  private toNewRow(input: ClaimTypeInput): NewClaimTypeRow {
    return {
      code: input.code,
      name: input.name,
      perClaimLimit: input.perClaimLimit ?? null,
      perClaimLimitKind: input.perClaimLimitKind ?? null,
      monthlyLimit: input.monthlyLimit ?? null,
      monthlyLimitKind: input.monthlyLimitKind ?? null,
      annualLimit: input.annualLimit ?? null,
      annualLimitKind: input.annualLimitKind ?? null,
      receiptRequired: input.receiptRequired,
      requiredFields: input.requiredFields ?? [],
      mileageRate: input.mileageRate ?? null,
      active: input.active ?? true,
    }
  }

  private validate(row: NewClaimTypeRow): void {
    if (row.code === 'mileage' && row.active && row.mileageRate === null) {
      throw invalidType('mileage claim type requires mileageRate before it can be active')
    }
    for (const [limit, kind, label] of [
      [row.perClaimLimit, row.perClaimLimitKind, 'perClaimLimit'],
      [row.monthlyLimit, row.monthlyLimitKind, 'monthlyLimit'],
      [row.annualLimit, row.annualLimitKind, 'annualLimit'],
    ] as const) {
      if (limit !== null && kind === null) throw invalidType(`${label} requires ${label}Kind (hard|soft)`)
      if (limit === null && kind !== null) throw invalidType(`${label}Kind set without ${label}`)
    }
  }
}
