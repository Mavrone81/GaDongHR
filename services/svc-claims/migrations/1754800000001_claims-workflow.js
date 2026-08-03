'use strict'

/**
 * Phase 4 (Task 14 brief "BUILD the P0 requirements") — the tables the base
 * `1754800000000_claims-schema.js` migration deliberately left out because
 * business logic was out of scope for that task. This migration adds
 * exactly what M6-1..M6-5's business logic needs to exist as DATA, not code:
 *
 *   `claims.claim_type` — M6-1 configurable types (travel/meal/medical/
 *     per_diem/mileage/...) with per-claim/monthly/annual limits (each with
 *     an independent hard-vs-soft `_kind`), receipt requirement, required
 *     fields, and a config-driven mileage rate (THB per km) — never a
 *     hard-coded rate in `.ts`.
 *
 *   `claims.approval_band` — M6-3's amount-banded approval chain. This is
 *     THE table that makes "the band thresholds come from config, never in
 *     code" true rather than aspirational: `approval-bands.service.ts` reads
 *     rows from here (via `approval-bands.repository.ts`) to decide how many
 *     levels a claim needs and who approves each one; there is no threshold
 *     constant anywhere in `src/*.ts` outside a test fixture. Seeded here
 *     with the PRD's own example (≤2,000 THB manager only; >2,000 THB
 *     manager + finance) as starting data, not as a fallback the code would
 *     use if the table were empty — `approval-bands.service.test.ts` proves
 *     the chain literally moves when a row's `max_amount` is edited.
 *
 * Plus the columns `claims.claim`/`claims.approval_step2` need to carry a
 * real workflow (submission metadata, rejection reason, resubmission round,
 * reimbursement routing) that the base migration's minimal ERD-only shape
 * did not include.
 *
 * Not executed against a real Postgres in this environment (same constraint
 * as the base migration — no Postgres here); `claims-workflow-schema.test.ts`
 * proves this migration's SQL shape the same way `claims-schema.test.ts`
 * proves the base migration's.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  // -------------------------------------------------------------------
  // claims.claim_type (M6-1)
  // -------------------------------------------------------------------
  pgm.createTable(
    { schema: 'claims', name: 'claim_type' },
    {
      code: { type: 'text', primaryKey: true },
      name: { type: 'text', notNull: true },
      // Every *_limit is numeric (never real/double precision — same
      // reasoning as claim.amount_thb in the base migration: these values
      // gate a reimbursement that becomes a non-taxable payroll line).
      // Nullable: a type may leave one or more limit tiers unconstrained.
      per_claim_limit: { type: 'numeric' },
      per_claim_limit_kind: { type: 'text' },
      monthly_limit: { type: 'numeric' },
      monthly_limit_kind: { type: 'text' },
      annual_limit: { type: 'numeric' },
      annual_limit_kind: { type: 'text' },
      receipt_required: { type: 'boolean', notNull: true, default: true },
      // Field names the employee's submission `fields` object must carry a
      // non-empty value for (M6-1 "required fields"). Stored as jsonb so
      // this stays admin-configurable data, not a TypeScript union.
      required_fields: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
      // THB per km — config-driven per M6-2 ("mileage claims compute from
      // distance × a configurable rate"). NULL for every non-mileage type;
      // `claim-types.service.ts` requires it be set before a `mileage`-kind
      // type can be activated.
      mileage_rate: { type: 'numeric' },
      active: { type: 'boolean', notNull: true, default: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  for (const col of ['per_claim_limit_kind', 'monthly_limit_kind', 'annual_limit_kind']) {
    pgm.addConstraint({ schema: 'claims', name: 'claim_type' }, `claim_type_${col}_check`, {
      check: `${col} IS NULL OR ${col} IN ('hard', 'soft')`,
    })
  }

  pgm.sql(`COMMENT ON TABLE claims.claim_type IS
    'M6-1 configurable claim types. Every *_limit_kind is hard|soft — the enforcement behaviour M6-5 branches on. mileage_rate is the ONLY source of the per-km rate; there is no fallback constant in code.'`)

  // -------------------------------------------------------------------
  // claims.approval_band (M6-3) — the config table that makes banding
  // config-driven rather than a constant. Ordered by sort_order ascending;
  // `approval-bands.service.ts` picks the first row whose max_amount is
  // NULL or >= the claim amount.
  // -------------------------------------------------------------------
  pgm.createTable(
    { schema: 'claims', name: 'approval_band' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      // Inclusive ceiling for this band; NULL = no ceiling (the top band).
      max_amount: { type: 'numeric' },
      // Ordered array of approver roles this band requires, one approval
      // level per entry, e.g. '["manager"]' or '["manager", "finance"]'.
      approver_roles: { type: 'jsonb', notNull: true },
      sort_order: { type: 'integer', notNull: true },
    },
  )
  pgm.addConstraint({ schema: 'claims', name: 'approval_band' }, 'approval_band_sort_order_key', {
    unique: ['sort_order'],
  })

  pgm.sql(`COMMENT ON TABLE claims.approval_band IS
    'M6-3 amount-banded approval chain, as DATA. The PRD example (<=2000 THB manager only; >2000 THB manager+finance) is seeded below as starting data, not a code fallback -- editing max_amount here changes the chain with no deploy. See approval-bands.service.test.ts.'`)

  // PRD/module-doc worked example, seeded as adjustable starting data.
  pgm.sql(`INSERT INTO claims.approval_band (max_amount, approver_roles, sort_order) VALUES
    (2000, '["manager"]'::jsonb, 1),
    (NULL, '["manager", "finance"]'::jsonb, 2)`)

  // -------------------------------------------------------------------
  // claims.claim — workflow columns the base migration's ERD-only shape
  // did not carry (submission metadata, rejection, resubmission round,
  // reimbursement routing).
  // -------------------------------------------------------------------
  pgm.addColumns(
    { schema: 'claims', name: 'claim' },
    {
      claim_date: { type: 'date' },
      vendor: { type: 'text' },
      // km for a mileage claim; amount_thb is DERIVED from this × the
      // claim_type's mileage_rate (M6-2), never entered directly for that
      // type.
      mileage_km: { type: 'numeric' },
      // Claim-level VAT total for tax-deductible expense reporting (M6-2) —
      // the sum of this claim's receipt.vat_amount rows at submission time.
      vat_amount: { type: 'numeric' },
      reimbursement_route: { type: 'text' },
      rejection_reason: { type: 'text' },
      // Increments on resubmit (M6-3) — disambiguates which round of
      // approval_step2 rows is the CURRENT one for a claim that was
      // rejected and resubmitted.
      round: { type: 'integer', notNull: true, default: 1 },
      // Set true when a SOFT limit was exceeded at submission (M6-5) — the
      // claim proceeds, but this flags it for approver attention.
      soft_limit_warning: { type: 'boolean', notNull: true, default: false },
      submitted_at: { type: 'timestamptz' },
      decided_at: { type: 'timestamptz' },
      routed_at: { type: 'timestamptz' },
      paid_at: { type: 'timestamptz' },
      // The submission payload's values for the claim_type's
      // `required_fields` (M6-1) — persisted so a resubmission (M6-3) can
      // re-validate against the CURRENT type config, and so the employee's
      // own submission is auditable end-to-end, not just validated once and
      // discarded.
      fields: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    },
  )
  pgm.addConstraint({ schema: 'claims', name: 'claim' }, 'claim_reimbursement_route_check', {
    check: "reimbursement_route IS NULL OR reimbursement_route IN ('payroll', 'offcycle')",
  })
  pgm.createIndex({ schema: 'claims', name: 'claim' }, ['employee_id', 'claim_type', 'claim_date'])

  // -------------------------------------------------------------------
  // claims.approval_step2 — round, so a resubmitted claim's new approval
  // chain does not collide with its rejected round's decided steps.
  // -------------------------------------------------------------------
  pgm.addColumns(
    { schema: 'claims', name: 'approval_step2' },
    { round: { type: 'integer', notNull: true, default: 1 } },
  )
  pgm.createIndex({ schema: 'claims', name: 'approval_step2' }, ['subject_id', 'round', 'level'], {
    name: 'approval_step2_subject_round_level_idx',
  })
}

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'claims', name: 'approval_band' }, { ifExists: true })
  pgm.dropTable({ schema: 'claims', name: 'claim_type' }, { ifExists: true })
  pgm.dropColumns({ schema: 'claims', name: 'approval_step2' }, ['round'])
  pgm.dropColumns({ schema: 'claims', name: 'claim' }, [
    'claim_date',
    'vendor',
    'mileage_km',
    'vat_amount',
    'reimbursement_route',
    'rejection_reason',
    'round',
    'soft_limit_warning',
    'submitted_at',
    'decided_at',
    'routed_at',
    'paid_at',
    'fields',
  ])
}
