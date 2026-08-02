import { EntriesRepository } from './entries.repository'
import type { EntryFilters } from './entries.repository'
import { verifyChain } from './chain'
import type { StoredEntry, VerifyResult } from './chain'

export interface ListEntriesInput {
  entity?: string
  entityId?: string
  from?: string
  to?: string
  page?: number
}

export interface ListEntriesResult {
  entries: StoredEntry[]
  page: number
}

/**
 * Business logic behind `/entries` and `/verify` — no SQL here
 * (`entries.repository.ts` owns that), matching every other service's
 * service/repository split.
 */
export class EntriesService {
  constructor(private readonly repo: EntriesRepository) {}

  /** `GET /entries` — `page` defaults to 1, and any non-positive or non-numeric page also falls back to 1 rather than erroring: a malformed page param is a client mistake worth tolerating, not a reason to fail a read-only audit query closed. */
  async list(input: ListEntriesInput): Promise<ListEntriesResult> {
    const page = input.page !== undefined && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : 1
    const filters: EntryFilters = {
      entity: input.entity,
      entityId: input.entityId,
      from: input.from,
      to: input.to,
    }
    const entries = await this.repo.findPage(filters, page)
    return { entries, page }
  }

  /** `GET /verify` — walks the whole chain (`chain.ts#verifyChain`, pure and independently tested) and reports which specific entries, if any, fail. */
  async verify(): Promise<VerifyResult> {
    const entries = await this.repo.findAllOrdered()
    return verifyChain(entries)
  }
}
