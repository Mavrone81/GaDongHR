'use strict'

/**
 * Extends payroll's committed-run immutability (added in
 * 1754700000000_payroll-schema.js) to `pay_item` and `statutory_export` —
 * a coordinator review finding on the original migration. The original
 * file's two triggers (`payroll_run`, `payslip`) left a real hole: a
 * committed run's header and its payslip rows were frozen, but its
 * `pay_item` rows (what a payslip itemises) and `statutory_export` rows
 * (the สปส.1-10/ภ.ง.ด.1 file references) stayed fully editable. A payslip
 * could show an unchanged net figure while the line items explaining it
 * were altered underneath, or a filed statutory export could be silently
 * swapped for a different file, all without touching a single protected
 * row. "The header was immutable" is not a defence in a Thai labour court
 * dispute over a committed run — an audit trail with a mutable middle is
 * worse than none, because it invites reliance on something that can still
 * move.
 *
 * TWO TARGETS, TWO JOIN SHAPES:
 *
 *  - `statutory_export` is a direct child of `payroll_run` (`run_id` ->
 *    `payroll_run.status`) — the SAME one-hop join
 *    `payroll.forbid_committed_run_child_mutation()` (from the parent
 *    migration) already uses for `payslip`. Per the review instruction to
 *    reuse a function when its logic generalises rather than duplicate a
 *    near-identical body, this file `CREATE OR REPLACE`s that existing
 *    function to also handle `TG_OP = 'INSERT'` (reading `NEW.run_id`
 *    instead of `OLD.run_id`) and points a new `statutory_export` trigger
 *    at it. `payslip`'s own trigger (defined in the parent migration) is
 *    NOT touched by this file and is still bound to `BEFORE UPDATE OR
 *    DELETE` only — the added INSERT branch is inert for any trigger that
 *    is never fired on INSERT, so `payslip`'s behaviour on its own table is
 *    unchanged, satisfying the review's "do not change the existing two
 *    triggers' behaviour on their own tables" constraint.
 *
 *  - `pay_item` is a GRANDchild of `payroll_run`, one hop further removed
 *    (`payslip_id` -> `payslip.run_id` -> `payroll_run.status`) — a
 *    genuinely different join the one-hop function cannot express, so this
 *    file adds a second function,
 *    `payroll.forbid_committed_run_grandchild_mutation()`, rather than
 *    forcing the shapes together.
 *
 * INSERT IS BLOCKED, NOT JUST UPDATE/DELETE: adding a new `pay_item` to a
 * committed payslip, or a new `statutory_export` to a committed run,
 * changes what that run's evidence says just as effectively as editing an
 * existing row would — so both new triggers fire on `BEFORE INSERT OR
 * UPDATE OR DELETE`. This deliberately does NOT block the correction path:
 * an `adjustment` run is its own `payroll_run` row, created with `status =
 * 'draft'` (per `payroll_run_status_check`'s allowed values and
 * `payroll_run_run_type_check`'s `'adjustment'` option, both from the
 * parent migration, unchanged). Inserting that adjustment run's `pay_item`/
 * `statutory_export` rows looks up THAT run's status — draft, not
 * committed — so populating a fresh adjustment run while an earlier
 * `regular` run sits committed continues to work exactly as before. Only
 * inserting (or updating/deleting) a child row against an ALREADY-committed
 * run's id is blocked. `payroll-child-immutability.test.ts` proves this
 * with a JS-level behavioural mirror of both trigger functions (there is
 * no Postgres in this environment to run the real SQL against — Task 14
 * brief CONSTRAINTS — matching `services/svc-config`'s `FakeConfigDb`
 * precedent for proving a DB constraint's behaviour without a live
 * database), alongside source-presence and mutation-demonstration tests in
 * the same style `payroll-schema.test.ts` already established for the
 * parent migration's SoD check and its two triggers.
 *
 * UNCHANGED by this file: the SoD CHECK (`payroll_run_sod_check`), all 13
 * bytea/encrypted columns, `timesheet_lock_version`, and `payroll_run`'s /
 * `payslip`'s own trigger definitions and behaviour.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 14 brief CONSTRAINTS, matching the parent migration and
 * Tasks 7/8/9/14's precedent).
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  // Reuse: generalise the existing one-hop function (originally payslip-
  // only, UPDATE/DELETE-only) to also handle INSERT, then bind BOTH
  // payslip's pre-existing trigger (unchanged — still UPDATE/DELETE only,
  // so this new branch never runs for it) and a new statutory_export
  // trigger (INSERT/UPDATE/DELETE) to it.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION payroll.forbid_committed_run_child_mutation() RETURNS trigger AS $$
    DECLARE
      target_run_id uuid;
      row_id uuid;
      run_status text;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        target_run_id := NEW.run_id;
        row_id := NEW.id;
      ELSE
        target_run_id := OLD.run_id;
        row_id := OLD.id;
      END IF;

      SELECT status INTO run_status FROM payroll.payroll_run WHERE id = target_run_id;
      IF run_status = 'committed' THEN
        RAISE EXCEPTION '% row % belongs to a committed payroll_run and is immutable -- corrections must go through a new adjustment run', TG_TABLE_NAME, row_id
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      ELSE
        RETURN NEW;
      END IF;
    END;
    $$ LANGUAGE plpgsql;
  `)

  pgm.sql(`
    CREATE TRIGGER statutory_export_immutable_when_run_committed
    BEFORE INSERT OR UPDATE OR DELETE ON payroll.statutory_export
    FOR EACH ROW
    EXECUTE FUNCTION payroll.forbid_committed_run_child_mutation();
  `)

  // Grandchild: pay_item -> payslip -> payroll_run. Two hops, so it cannot
  // reuse the one-hop function above — a second function instead of
  // forcing an unrelated join shape into it.
  pgm.sql(`
    CREATE FUNCTION payroll.forbid_committed_run_grandchild_mutation() RETURNS trigger AS $$
    DECLARE
      target_payslip_id uuid;
      row_id uuid;
      run_status text;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        target_payslip_id := NEW.payslip_id;
        row_id := NEW.id;
      ELSE
        target_payslip_id := OLD.payslip_id;
        row_id := OLD.id;
      END IF;

      SELECT pr.status INTO run_status
      FROM payroll.payslip ps
      JOIN payroll.payroll_run pr ON pr.id = ps.run_id
      WHERE ps.id = target_payslip_id;

      IF run_status = 'committed' THEN
        RAISE EXCEPTION 'pay_item row % belongs to a payslip on a committed payroll_run and is immutable -- corrections must go through a new adjustment run', row_id
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      ELSE
        RETURN NEW;
      END IF;
    END;
    $$ LANGUAGE plpgsql;
  `)

  pgm.sql(`
    CREATE TRIGGER pay_item_immutable_when_run_committed
    BEFORE INSERT OR UPDATE OR DELETE ON payroll.pay_item
    FOR EACH ROW
    EXECUTE FUNCTION payroll.forbid_committed_run_grandchild_mutation();
  `)
}

exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS pay_item_immutable_when_run_committed ON payroll.pay_item')
  pgm.sql('DROP FUNCTION IF EXISTS payroll.forbid_committed_run_grandchild_mutation()')
  pgm.sql('DROP TRIGGER IF EXISTS statutory_export_immutable_when_run_committed ON payroll.statutory_export')
  // Restore forbid_committed_run_child_mutation() to the pre-INSERT-aware
  // body 1754700000000_payroll-schema.js originally defined, so rolling
  // back JUST this migration (as opposed to dropping the whole schema)
  // leaves payslip's trigger backed by exactly the function body it had
  // before this file touched it.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION payroll.forbid_committed_run_child_mutation() RETURNS trigger AS $$
    DECLARE
      run_status text;
    BEGIN
      SELECT status INTO run_status FROM payroll.payroll_run WHERE id = OLD.run_id;
      IF run_status = 'committed' THEN
        RAISE EXCEPTION 'payslip % belongs to a committed payroll_run and is immutable -- corrections must go through a new adjustment run', OLD.id
          USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      ELSE
        RETURN NEW;
      END IF;
    END;
    $$ LANGUAGE plpgsql;
  `)
}
