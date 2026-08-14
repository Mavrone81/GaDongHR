import type { Queryable } from '@gadong/kernel'

export interface DocsEmployeeRefRow {
  employeeId: string
  orgUnitId: string
  updatedAt: string
}

export interface UpsertDocsEmployeeRef {
  employeeId: string
  orgUnitId: string
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`EmployeeRefRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

const SELECT_COLUMNS = 'employee_id, org_unit_id, updated_at'

function mapRow(row: Record<string, unknown>): DocsEmployeeRefRow {
  return {
    employeeId: String(row['employee_id']),
    orgUnitId: String(row['org_unit_id']),
    updatedAt: toIso(row['updated_at']),
  }
}

/**
 * `docs.employee_ref` — fed by `employee.created`/`employee.updated`
 * (`events.consumer.ts`'s `handleEmployeeUpsert`), the row-scoping fix's
 * local read model: resolves which org unit an `entity_type = 'employee'`
 * document's owner belongs to, without a cross-schema query into
 * `onboarding.employee` (roadmap "Database conventions": "No foreign keys
 * across schemas. No cross-schema queries"). Mirrors
 * `services/svc-timesheet/src/employee-ref.repository.ts` exactly, minus
 * the columns `svc-timesheet` needs for OT classification that `svc-docs`
 * has no use for.
 */
export class EmployeeRefRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(tx: Queryable, row: UpsertDocsEmployeeRef): Promise<DocsEmployeeRefRow> {
    const { rows } = await tx.query(
      `INSERT INTO docs.employee_ref (employee_id, org_unit_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (employee_id) DO UPDATE
         SET org_unit_id = EXCLUDED.org_unit_id, updated_at = now()
       RETURNING ${SELECT_COLUMNS}`,
      [row.employeeId, row.orgUnitId],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('EmployeeRefRepository.upsert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findById(employeeId: string): Promise<DocsEmployeeRefRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM docs.employee_ref WHERE employee_id = $1`, [employeeId])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
