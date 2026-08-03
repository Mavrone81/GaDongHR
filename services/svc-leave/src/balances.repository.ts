import type { Queryable } from '@gadong/kernel'

export interface LeaveBalanceRow {
  id: string
  employeeId: string
  leaveTypeId: string
  /** All three are `numeric` strings — see `decimal.ts`. */
  entitled: string
  taken: string
  carriedOver: string
  year: number
}

export interface NewLeaveBalanceRow {
  id: string
  employeeId: string
  leaveTypeId: string
  entitled: string
  taken: string
  carriedOver: string
  year: number
}

export interface LedgerEntryRow {
  id: string
  employeeId: string
  leaveTypeId: string
  year: number
  delta: string
  reason: string
  refId: string | null
  createdAt: string
}

export interface NewLedgerEntryRow {
  id: string
  employeeId: string
  leaveTypeId: string
  year: number
  delta: string
  reason: string
  refId: string | null
}

function mapBalanceRow(row: Record<string, unknown>): LeaveBalanceRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    leaveTypeId: String(row['leave_type_id']),
    entitled: String(row['entitled']),
    taken: String(row['taken']),
    carriedOver: String(row['carried_over']),
    year: Number(row['year']),
  }
}

function mapLedgerRow(row: Record<string, unknown>): LedgerEntryRow {
  const createdAt = row['created_at']
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    leaveTypeId: String(row['leave_type_id']),
    year: Number(row['year']),
    delta: String(row['delta']),
    reason: String(row['reason']),
    refId: row['ref_id'] === null || row['ref_id'] === undefined ? null : String(row['ref_id']),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  }
}

/**
 * SQL for `leave_balance` (the current-state cache) and `balance_ledger`
 * (the immutable append-only trail — M5-LEAVE.md's `BalanceLedger` class:
 * "append(entry) // immutable audit of every +/-"). No business logic here
 * (`balances.service.ts` owns that), matching every other repository/
 * service split in this service.
 */
export class BalancesRepository {
  constructor(private readonly db: Queryable) {}

  async findOne(employeeId: string, leaveTypeId: string, year: number): Promise<LeaveBalanceRow | null> {
    const all = await this.listByEmployee(employeeId)
    return all.find((r) => r.leaveTypeId === leaveTypeId && r.year === year) ?? null
  }

  async listByEmployee(employeeId: string): Promise<LeaveBalanceRow[]> {
    const { rows } = await this.db.query('SELECT * FROM leave.leave_balance WHERE employee_id = $1', [employeeId])
    return rows.map(mapBalanceRow)
  }

  async insert(tx: Queryable, row: NewLeaveBalanceRow): Promise<LeaveBalanceRow> {
    const { rows } = await tx.query(
      `INSERT INTO leave.leave_balance (id, employee_id, leave_type_id, entitled, taken, carried_over, year)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [row.id, row.employeeId, row.leaveTypeId, row.entitled, row.taken, row.carriedOver, row.year],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('BalancesRepository.insert: INSERT ... RETURNING produced no row')
    return mapBalanceRow(inserted)
  }

  async update(
    tx: Queryable,
    id: string,
    patch: Partial<Pick<NewLeaveBalanceRow, 'entitled' | 'taken' | 'carriedOver'>>,
  ): Promise<LeaveBalanceRow | null> {
    const assignments: string[] = []
    const params: unknown[] = [id]
    const push = (column: string, value: unknown): void => {
      params.push(value)
      assignments.push(`${column} = $${params.length}`)
    }
    if (patch.entitled !== undefined) push('entitled', patch.entitled)
    if (patch.taken !== undefined) push('taken', patch.taken)
    if (patch.carriedOver !== undefined) push('carried_over', patch.carriedOver)
    if (assignments.length === 0) {
      const all = await this.db.query('SELECT * FROM leave.leave_balance WHERE id = $1', [id])
      return all.rows.length > 0 && all.rows[0] !== undefined ? mapBalanceRow(all.rows[0]) : null
    }
    const { rows } = await tx.query(`UPDATE leave.leave_balance SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`, params)
    return rows.length > 0 && rows[0] !== undefined ? mapBalanceRow(rows[0]) : null
  }

  async appendLedgerEntry(tx: Queryable, row: NewLedgerEntryRow): Promise<LedgerEntryRow> {
    const { rows } = await tx.query(
      `INSERT INTO leave.balance_ledger (id, employee_id, leave_type_id, year, delta, reason, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [row.id, row.employeeId, row.leaveTypeId, row.year, row.delta, row.reason, row.refId],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('BalancesRepository.appendLedgerEntry: INSERT ... RETURNING produced no row')
    return mapLedgerRow(inserted)
  }

  async listLedger(employeeId: string, leaveTypeId: string): Promise<LedgerEntryRow[]> {
    // Fetched by employee_id (a single equality WHERE, matching the fake
    // DB's supported shape — see `testing/fake-db.ts`'s header) and
    // filtered/sorted by leaveTypeId + createdAt here rather than in SQL;
    // ledger volume per employee is small enough that this is not a
    // performance concern, and it keeps every repository in this service
    // to the same "equality WHERE, application-level filter" shape.
    const { rows } = await this.db.query('SELECT * FROM leave.balance_ledger WHERE employee_id = $1', [employeeId])
    return rows
      .map(mapLedgerRow)
      .filter((r) => r.leaveTypeId === leaveTypeId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}
