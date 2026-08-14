'use strict'

/**
 * Row-scoping fix (roadmap "🔴 Open security gap — permissions are too
 * coarse for row-level access"): `GET /documents/:id` is guarded by a
 * single `document.read` permission with no per-document ownership check —
 * "An employee who enumerates a document id reaches a colleague's
 * payslip." Closing that requires knowing WHO a document belongs to, and
 * `docs.document.entity_id` alone does not answer that for every `kind`:
 *
 *   - `entity_type = 'employee'` (contracts, letters — `svc-onboarding`'s
 *     `contract.service.ts`): `entity_id` IS the employee id directly.
 *   - `entity_type = 'payslip'` (`svc-payroll`'s `ports.ts`): `entity_id` is
 *     the PAYSLIP's id, not the employee's — a payslip document's owner has
 *     to be resolved separately.
 *
 * Two local read models, fed by the roadmap's own event catalog (no
 * cross-schema query — "Database conventions": "No foreign keys across
 * schemas. No cross-schema queries" — matches `svc-timesheet`'s
 * `timesheet_employee_ref` pattern exactly, `1756000000000_timesheet-
 * schema.js`):
 *
 *   - `docs.employee_ref(employee_id, org_unit_id)` — fed by
 *     `employee.created`/`employee.updated`, resolves an `entity_type =
 *     'employee'` document's owner's org unit for an org-scoped grant, and
 *     backs the `'self'`-scope ownership check directly (`entity_id ===
 *     callerId`, no lookup needed for that case).
 *   - `docs.payslip_ref(payslip_id, employee_id)` — fed by `payslip.issued`
 *     (roadmap event catalog: `{payslipId, runId, employeeId, lang}`),
 *     resolves an `entity_type = 'payslip'` document's owning employee, so
 *     the same ownership/scope check applies uniformly to both kinds.
 *
 * Not executed against a real Postgres in this environment during
 * authoring — a later integration/e2e run applies it for real, same
 * deferred-verification note every other service's migration carries.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'docs', name: 'employee_ref' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      org_unit_id: { type: 'uuid', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )

  pgm.createTable(
    { schema: 'docs', name: 'payslip_ref' },
    {
      payslip_id: { type: 'uuid', primaryKey: true },
      employee_id: { type: 'uuid', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.createIndex({ schema: 'docs', name: 'payslip_ref' }, ['employee_id'])
}

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'docs', name: 'payslip_ref' }, { ifExists: true })
  pgm.dropTable({ schema: 'docs', name: 'employee_ref' }, { ifExists: true })
}
