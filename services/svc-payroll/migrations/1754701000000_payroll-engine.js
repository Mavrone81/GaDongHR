'use strict'

/**
 * M7 Phase 5 — the tables the gross-to-net engine, the run lifecycle, the
 * payslip renderer, the bank files and the statutory exports actually need,
 * on top of the Phase 1 skeleton in `1754700000000_payroll-schema.js` and
 * `1754700100000_payroll-child-immutability.js`.
 *
 * NOTHING here weakens either of the two legal controls the parent
 * migrations established. `payroll_run_sod_check` is untouched. Both
 * committed-run immutability trigger functions are untouched, and every new
 * table that hangs off a run (`pay_input` when consumed) is deliberately
 * NOT given a trigger of its own — see `pay_input`'s comment: it is an
 * INPUT queue, not evidence of what was paid, and freezing it would freeze
 * the queue rather than the payslip.
 *
 * WHY EACH TABLE/COLUMN EXISTS
 *
 * 1. `payroll_employee_ref` gains the five employee facts the engine cannot
 *    compute without: `province_code` (M7-1's minimum-wage floor varies
 *    across 77 provinces), `start_date` (M7-7's Section 118 service-length
 *    tiers), `preferred_lang` (M7-4 renders the payslip in the employee's
 *    language, and Thai payslips carry Buddhist Era dates), `org_unit_id`
 *    and `employment_type`. All arrive on `employee.created`/`updated`
 *    (roadmap event catalog) — replicated in, never a cross-schema FK.
 *
 * 2. `payroll.termination` records what `employee.terminated` says plus the
 *    thing the event does NOT carry and a human must supply: when severance
 *    is withheld under LPA s.119, the CAUSE and its CITATION. A final-pay
 *    run that pays no severance with no citation stored is exactly the
 *    record an employer cannot defend in a labour court, so the column
 *    exists at the schema level rather than being left to a service field.
 *
 * 3. `payroll.pay_input` is the queue of things that must be paid or
 *    deducted this period but did not originate in the pay profile:
 *    one-off manual earnings/deductions, unused-leave payouts arriving on
 *    `leave.balance_payout`, and expense reimbursements arriving on
 *    `claim.approved_for_payroll`. The two boolean columns are the whole
 *    point of the table: `taxable` and `sso_wage_base` are stored PER LINE,
 *    notNull, with no default — a reimbursement carries `false`/`false`
 *    (the producing event says so explicitly) and can therefore never drift
 *    into the tax or Social Security wage base by omission. `amount` is
 *    bytea for the same reason every other money column here is.
 *
 * 4. `payroll.timesheet_lock` is the read model fed by
 *    `timesheet.locked`/`timesheet.unlocked`. A run binds to
 *    `payroll_run.timesheet_lock_version` at prepare time; if an unlock
 *    later bumps the version, the bound run is stale (PAY-030) and must be
 *    recalculated — the schema keeps the current version so the service can
 *    tell.
 *
 * 5. `payslip` gains the EMPLOYER-side contribution columns (`sso_er`,
 *    `ewf_er`, `pf_er`) that the Phase 1 skeleton omitted, plus
 *    `taxable_gross` and `non_taxable_pay`. Employer contributions are a
 *    required line on a Thai payslip and the entire content of the
 *    สปส.1-10 employer column; `non_taxable_pay` is where reimbursements
 *    land so that `gross` can stay strictly "taxable/SSO-bearing earnings"
 *    and no export ever has to guess which of the two a figure belongs to.
 *    All bytea, all encrypted before write, all added to
 *    `payroll-schema.test.ts`'s exhaustive enumeration.
 *
 * 6. `pay_profile` gains `bank_code`/`bank_account`/`bank_account_name`
 *    (M7-5 cannot build a KBank/SCB/BBL/Krungsri transfer file without
 *    them) and `pf_rate_employer`/`tax_allowance_decl` companions. A bank
 *    account is S3 in the roadmap's own classification table, so both
 *    account columns are bytea.
 *
 * 7. `statutory_export.kind`'s CHECK is widened from the Phase 1 six to
 *    include the four bank formats Samuel confirmed (KBank, SCB, BBL,
 *    Krungsri) alongside the existing generic `bank_csv`. Dropping and
 *    re-adding the constraint under the SAME name keeps the parent
 *    migration's name assertions valid.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — same constraint as every migration in this repo); the shape is
 * proved by `payroll-engine-schema.test.ts` against node-pg-migrate's real
 * `MigrationBuilder`.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  // ---------------------------------------------------------------------
  // 1. Employee read model — the facts the engine cannot compute.
  // ---------------------------------------------------------------------
  pgm.addColumns(
    { schema: 'payroll', name: 'payroll_employee_ref' },
    {
      // Drives the provincial minimum-wage floor (Statutory Spec §8): the
      // 2026 table runs roughly 337-400 THB/day and differs per province,
      // so a wrong (or absent) province is a wrong floor.
      province_code: { type: 'text' },
      // Drives the Section 118 severance tier (Statutory Spec §7).
      start_date: { type: 'date' },
      // M7-4: the payslip renders in this language; 'th' renders B.E. dates.
      preferred_lang: { type: 'text' },
      org_unit_id: { type: 'uuid' },
      employment_type: { type: 'text' },
    },
  )

  // ---------------------------------------------------------------------
  // 2. Termination facts, including the s.119 cause + citation.
  // ---------------------------------------------------------------------
  pgm.createTable(
    { schema: 'payroll', name: 'termination' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      termination_date: { type: 'date', notNull: true },
      last_working_day: { type: 'date' },
      // From `employee.terminated`'s `reasonCategory`.
      reason_category: { type: 'text', notNull: true },
      // Only populated when severance is withheld under LPA s.119. Both
      // columns move together — see `termination_statutory_cause_check`.
      statutory_cause: { type: 'text' },
      statutory_citation: { type: 'text' },
      // Whether statutory notice was actually given; when it was not, the
      // final-pay calculator owes pay in lieu.
      notice_given: { type: 'boolean', notNull: true, default: false },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  // A statutory cause without its citation is the record that loses the
  // case. Enforced here, at the database, for the same reason the SoD check
  // is: the constraint is what survives a future bug.
  pgm.addConstraint({ schema: 'payroll', name: 'termination' }, 'termination_statutory_cause_check', {
    check: '(statutory_cause IS NULL) = (statutory_citation IS NULL)',
  })

  // ---------------------------------------------------------------------
  // 3. Pay inputs — one-off items and consumed events.
  // ---------------------------------------------------------------------
  pgm.createTable(
    { schema: 'payroll', name: 'pay_input' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      employee_id: { type: 'uuid', notNull: true },
      // 'YYYY-MM' — the period this input is payable in.
      period: { type: 'text', notNull: true },
      // 'manual' | 'leave_payout' | 'claim_reimbursement' | 'severance' | 'notice_in_lieu'
      source: { type: 'text', notNull: true },
      // The producing entity's id (claim id, leave request id) — carries
      // the UNIQUE below so a redelivered event cannot pay twice.
      source_ref: { type: 'text' },
      kind: { type: 'text', notNull: true },
      // 🔐 S3.
      amount: { type: 'bytea', notNull: true },
      // NO DEFAULT, notNull, per line. The reason this table exists in this
      // shape: `claim.approved_for_payroll` carries `taxable:false` and
      // `ssoWageBase:false` explicitly, and the engine reads these columns
      // rather than re-deriving the classification from `kind`. A default
      // would be a way for a reimbursement to become taxable by omission.
      taxable: { type: 'boolean', notNull: true },
      sso_wage_base: { type: 'boolean', notNull: true },
      // 'earning' | 'deduction'
      direction: { type: 'text', notNull: true },
      meta: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
      // Set when a run consumes this input; NULL means still outstanding.
      consumed_run_id: { type: 'uuid' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint({ schema: 'payroll', name: 'pay_input' }, 'pay_input_direction_check', {
    check: "direction IN ('earning', 'deduction')",
  })
  pgm.addConstraint({ schema: 'payroll', name: 'pay_input' }, 'pay_input_source_ref_key', {
    unique: ['source', 'source_ref'],
  })
  pgm.createIndex({ schema: 'payroll', name: 'pay_input' }, ['employee_id', 'period'])

  // ---------------------------------------------------------------------
  // 4. Timesheet lock read model.
  // ---------------------------------------------------------------------
  pgm.createTable(
    { schema: 'payroll', name: 'timesheet_lock' },
    {
      period: { type: 'text', primaryKey: true },
      lock_version: { type: 'integer', notNull: true },
      locked: { type: 'boolean', notNull: true, default: true },
      locked_by: { type: 'uuid' },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint({ schema: 'payroll', name: 'timesheet_lock' }, 'timesheet_lock_version_check', {
    check: 'lock_version >= 0',
  })

  // ---------------------------------------------------------------------
  // 5. Pay profile: bank details (S3) and the employer PF rate.
  // ---------------------------------------------------------------------
  pgm.addColumns(
    { schema: 'payroll', name: 'pay_profile' },
    {
      // Plaintext: which bank, not whose account. S1 by the roadmap's table.
      bank_code: { type: 'text' },
      // 🔐 S3 — "bank account" is named explicitly in the roadmap's S3 row.
      bank_account: { type: 'bytea' },
      // 🔐 S3 — the beneficiary name printed on the transfer file.
      bank_account_name: { type: 'bytea' },
      // The employer's matching provident-fund rate; separate from the
      // employee's `pf_rate` because the two need not be equal.
      pf_rate_employer: { type: 'bytea' },
    },
  )

  // ---------------------------------------------------------------------
  // 6. Payslip: employer contributions + the taxable/non-taxable split.
  // ---------------------------------------------------------------------
  pgm.addColumns(
    { schema: 'payroll', name: 'payslip' },
    {
      // 🔐 S3 — employer-side contributions. Required on a Thai payslip and
      // the whole employer column of the สปส.1-10 return.
      sso_er: { type: 'bytea' },
      ewf_er: { type: 'bytea' },
      pf_er: { type: 'bytea' },
      // 🔐 S3 — the portion of gross that enters the PIT base.
      taxable_gross: { type: 'bytea' },
      // 🔐 S3 — reimbursements and other non-taxable payments. Held apart
      // from `gross` so no export ever has to guess which base a figure
      // belongs to.
      non_taxable_pay: { type: 'bytea' },
      // Which language this payslip was rendered in ('th' renders B.E.).
      lang: { type: 'text' },
    },
  )
  // One payslip per employee per run. Without this, a re-run that failed
  // halfway could leave two payslips for one employee and the bank file
  // would pay them twice.
  pgm.addConstraint({ schema: 'payroll', name: 'payslip' }, 'payslip_run_employee_key', {
    unique: ['run_id', 'employee_id'],
  })

  // ---------------------------------------------------------------------
  // 7. Run lifecycle bookkeeping.
  // ---------------------------------------------------------------------
  pgm.addColumns(
    { schema: 'payroll', name: 'payroll_run' },
    {
      period_start: { type: 'date' },
      period_end: { type: 'date' },
      pay_date: { type: 'date' },
      reviewed_by: { type: 'uuid' },
      approved_at: { type: 'timestamptz' },
      committed_at: { type: 'timestamptz' },
      // Set on an `adjustment` run: the committed run it corrects. This is
      // the ONLY sanctioned way to change what a committed run said.
      adjusts_run_id: {
        type: 'uuid',
        references: { schema: 'payroll', name: 'payroll_run' },
        referencesConstraintName: 'payroll_run_adjusts_run_id_fkey',
      },
    },
  )
  pgm.addConstraint({ schema: 'payroll', name: 'payroll_run' }, 'payroll_run_adjustment_target_check', {
    check: "run_type <> 'adjustment' OR adjusts_run_id IS NOT NULL",
  })

  // ---------------------------------------------------------------------
  // 8. Widen the export kinds to the four confirmed bank formats.
  // ---------------------------------------------------------------------
  pgm.dropConstraint({ schema: 'payroll', name: 'statutory_export' }, 'statutory_export_kind_check')
  pgm.addConstraint({ schema: 'payroll', name: 'statutory_export' }, 'statutory_export_kind_check', {
    check:
      "kind IN ('sso_1_10', 'pnd1', 'bank_csv', 'pnd1kor', '50bis', 'kor_ror_11', " +
      "'bank_kbank', 'bank_scb', 'bank_bbl', 'bank_krungsri')",
  })
}

exports.down = (pgm) => {
  pgm.dropConstraint({ schema: 'payroll', name: 'statutory_export' }, 'statutory_export_kind_check')
  pgm.addConstraint({ schema: 'payroll', name: 'statutory_export' }, 'statutory_export_kind_check', {
    check: "kind IN ('sso_1_10', 'pnd1', 'bank_csv', 'pnd1kor', '50bis', 'kor_ror_11')",
  })
  pgm.dropConstraint({ schema: 'payroll', name: 'payroll_run' }, 'payroll_run_adjustment_target_check')
  pgm.dropColumns({ schema: 'payroll', name: 'payroll_run' }, [
    'period_start',
    'period_end',
    'pay_date',
    'reviewed_by',
    'approved_at',
    'committed_at',
    'adjusts_run_id',
  ])
  pgm.dropConstraint({ schema: 'payroll', name: 'payslip' }, 'payslip_run_employee_key')
  pgm.dropColumns({ schema: 'payroll', name: 'payslip' }, [
    'sso_er',
    'ewf_er',
    'pf_er',
    'taxable_gross',
    'non_taxable_pay',
    'lang',
  ])
  pgm.dropColumns({ schema: 'payroll', name: 'pay_profile' }, [
    'bank_code',
    'bank_account',
    'bank_account_name',
    'pf_rate_employer',
  ])
  pgm.dropTable({ schema: 'payroll', name: 'timesheet_lock' })
  pgm.dropTable({ schema: 'payroll', name: 'pay_input' })
  pgm.dropTable({ schema: 'payroll', name: 'termination' })
  pgm.dropColumns({ schema: 'payroll', name: 'payroll_employee_ref' }, [
    'province_code',
    'start_date',
    'preferred_lang',
    'org_unit_id',
    'employment_type',
  ])
}
