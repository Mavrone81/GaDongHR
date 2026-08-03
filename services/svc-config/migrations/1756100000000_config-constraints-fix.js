'use strict'

/**
 * Fixes Task 16c's defect for `config`. `1754000000000_config-schema.js`
 * declared `statutory_rule`'s constraints as
 * `{ constraints: { statutory_rule_rule_key_effective_from_key: {...}, ... } }`
 * — a constraint NAME nested one level inside `options.constraints`, not one
 * of the KINDS (`unique`/`check`/`primaryKey`/`foreignKeys`/`exclude`)
 * node-pg-migrate 7.9.1's `parseConstraints`
 * (`dist/operations/tables/shared.js`) actually looks for. `parseConstraints`
 * destructures those kinds directly off the object it is given; a nested,
 * arbitrarily-named key is invisible to it, so `CREATE TABLE` ran and
 * silently produced none of these four constraints. Confirmed against
 * `pg_constraint`-equivalent inspection alongside `svc-authz`'s live finding
 * (Task 16c) — the same bug, same silent failure mode, same file shape.
 *
 * `1754000000000_config-schema.js` itself is deliberately NOT edited here:
 * `config` is one of the seven platform services in
 * `deploy/docker-compose.prod.yml` (deployed at Task 16, "First deployment
 * to gadonghr-prod"), so that migration already ran on `gadonghr-prod` and
 * editing it changes nothing there — node-pg-migrate never re-runs a
 * migration once its name is recorded in `pgmigrations`. It must also not be
 * "corrected" in place: on a brand-new environment that replays every
 * migration from scratch, if the parent migration created these constraints
 * AND this one also tried to, `pgm.addConstraint` would fail with
 * "constraint already exists". Leaving the parent exactly as it is (the same
 * no-op for constraints it always was) and adding them here, once, keeps
 * prod and every fresh environment consistent.
 *
 * De-duplication before the UNIQUE: `statutory_rule_rule_key_effective_from_key`
 * has never been enforced, so it is possible the live table already holds
 * more than one row for the same `(rule_key, effective_from)` pair. Adding
 * the constraint against such rows fails outright, so this migration
 * de-dupes first (keeping the lowest `id` per conflicting pair — an
 * arbitrary but deterministic survivor; there is no "correct" one to prefer
 * without a business decision this migration is not the place to make).
 *
 * What each constraint protects:
 *  - `statutory_rule_rule_key_effective_from_key` (UNIQUE `rule_key,
 *    effective_from`) — a data class can be re-legislated with a new
 *    `effective_from` row, but never silently duplicated for the same
 *    effective date; without it, `rules.service.ts` could otherwise create
 *    two "current" rows for the same rule and date, making rule resolution
 *    ambiguous.
 *  - `statutory_rule_governance_class_check` / `statutory_rule_status_check`
 *    (CHECK, enumerated vocabularies) — data-quality controls: a typo'd
 *    `governance_class` or `status` silently corrupts how a rule is treated
 *    (e.g. `STATUTORY_FLOOR` vs `COMPANY_POLICY`) with nothing to reject it.
 *  - `statutory_rule_sod_check` (CHECK `proposed_by IS NULL OR approved_by
 *    IS NULL OR proposed_by <> approved_by`) — a CORRECTNESS/COMPLIANCE
 *    control, the same segregation-of-duties shape `svc-payroll`'s
 *    `payroll_run_sod_check` enforces: the person who proposes a statutory
 *    rule change may not also be its approver. `rules.service.ts` carries
 *    the equivalent application-level check (the "brace"); this CHECK is the
 *    DB "belt" — until this migration, it did not exist at the database
 *    layer at all.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  // Defensive de-dup — see file header. No-op if the live table is already
  // clean.
  pgm.sql(`
    DELETE FROM config.statutory_rule a USING config.statutory_rule b
    WHERE a.rule_key = b.rule_key
      AND a.effective_from = b.effective_from
      AND a.id > b.id;
  `)

  pgm.addConstraint(
    { schema: 'config', name: 'statutory_rule' },
    'statutory_rule_rule_key_effective_from_key',
    { unique: ['rule_key', 'effective_from'] },
  )
  pgm.addConstraint(
    { schema: 'config', name: 'statutory_rule' },
    'statutory_rule_governance_class_check',
    { check: "governance_class IN ('STATUTORY_FLOOR', 'STATUTORY_FIXED', 'COMPANY_POLICY')" },
  )
  pgm.addConstraint(
    { schema: 'config', name: 'statutory_rule' },
    'statutory_rule_status_check',
    { check: "status IN ('draft', 'pending_approval', 'active', 'superseded')" },
  )
  pgm.addConstraint(
    { schema: 'config', name: 'statutory_rule' },
    'statutory_rule_sod_check',
    { check: 'proposed_by IS NULL OR approved_by IS NULL OR proposed_by <> approved_by' },
  )
}

exports.down = (pgm) => {
  pgm.dropConstraint({ schema: 'config', name: 'statutory_rule' }, 'statutory_rule_sod_check')
  pgm.dropConstraint(
    { schema: 'config', name: 'statutory_rule' },
    'statutory_rule_status_check',
  )
  pgm.dropConstraint(
    { schema: 'config', name: 'statutory_rule' },
    'statutory_rule_governance_class_check',
  )
  pgm.dropConstraint(
    { schema: 'config', name: 'statutory_rule' },
    'statutory_rule_rule_key_effective_from_key',
  )
}
