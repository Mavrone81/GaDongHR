import type { Queryable } from '@gadong/kernel'

export interface ApprovalBandRow {
  id: string
  maxAmount: string | null
  approverRoles: string[]
  sortOrder: number
}

export interface NewApprovalBandRow {
  maxAmount: string | null
  approverRoles: string[]
  sortOrder: number
}

const SELECT_COLUMNS = `id, max_amount, approver_roles, sort_order`

function mapRow(row: Record<string, unknown>): ApprovalBandRow {
  return {
    id: String(row['id']),
    maxAmount: row['max_amount'] === null || row['max_amount'] === undefined ? null : String(row['max_amount']),
    approverRoles: row['approver_roles'] as string[],
    sortOrder: Number(row['sort_order']),
  }
}

/**
 * SQL only for `claims.approval_band` — THE config table M6-3 reads to band
 * a claim's amount into an ordered approver-role chain. No banding logic
 * lives here (`approval-bands.service.ts` owns that); this file only
 * lists/replaces rows.
 */
export class ApprovalBandsRepository {
  constructor(private readonly db: Queryable) {}

  /** Ascending by `sort_order` — the order `approval-bands.service.ts` walks to find the first band whose ceiling covers a given amount. */
  async list(): Promise<ApprovalBandRow[]> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM claims.approval_band ORDER BY sort_order`)
    return rows.map(mapRow)
  }

  /** Replaces the ENTIRE band configuration in one transaction — this is a full-config PUT (`approval-bands.service.ts` validates the new set before calling this), not a per-row patch, because bands only make sense as an ordered, gapless whole. */
  async replaceAll(tx: Queryable, bands: NewApprovalBandRow[]): Promise<ApprovalBandRow[]> {
    await tx.query('DELETE FROM claims.approval_band')
    const inserted: ApprovalBandRow[] = []
    for (const band of bands) {
      const { rows } = await tx.query(
        `INSERT INTO claims.approval_band (max_amount, approver_roles, sort_order)
         VALUES ($1, $2::jsonb, $3)
         RETURNING ${SELECT_COLUMNS}`,
        [band.maxAmount, JSON.stringify(band.approverRoles), band.sortOrder],
      )
      const row = rows[0]
      if (row === undefined) throw new Error('ApprovalBandsRepository.replaceAll: INSERT ... RETURNING produced no row')
      inserted.push(mapRow(row))
    }
    return inserted
  }
}
