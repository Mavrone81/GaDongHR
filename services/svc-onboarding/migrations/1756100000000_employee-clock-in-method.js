'use strict'

/**
 * M1-3 (PDPA consent capture) needs somewhere to record which clock-in
 * method an employee actually uses — biometric (the default) or the
 * always-offered alternative (PIN/QR/badge) an employee is switched to on
 * biometric refusal or withdrawal.
 *
 * **This is deliberately NOT an adverse-flag column.** PDPA-BIOMETRIC-
 * COMPLIANCE.md §4.2 is explicit: "refusal is recorded without any
 * adverse-flag field existing in the schema" — the whole legal argument
 * that biometric consent is freely given rests on refusal having no
 * negative consequence anywhere in the data model. `clock_in_method` does
 * not say "refused"/"flagged"/"denied" and carries no polarity — it is
 * the same kind of neutral routing fact as `preferred_lang`: which of two
 * equally-supported operational paths this employee's attendance goes
 * through. A refusal writes `'alternative'` into this column for exactly
 * the same reason a withdrawal does; nothing here distinguishes "never
 * consented" from "consented, then withdrew" — both simply read
 * `'alternative'`, because the compliance requirement is that neither
 * carries a worse outcome than the other. Consent history/decision
 * (granted/refused/withdrawn) lives entirely in `consent_record` — the
 * append-only, purpose-scoped record — never here.
 *
 * Defaults to `'biometric'`: every employee starts on the biometric path
 * (the product's normal attendance method) until a consent decision on the
 * `biometric` purpose says otherwise.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.addColumn(
    { schema: 'onboarding', name: 'employee' },
    { clock_in_method: { type: 'text', notNull: true, default: 'biometric' } },
  )
  pgm.addConstraint(
    { schema: 'onboarding', name: 'employee' },
    'employee_clock_in_method_check',
    { check: "clock_in_method IN ('biometric', 'alternative')" },
  )
}

exports.down = (pgm) => {
  pgm.dropConstraint({ schema: 'onboarding', name: 'employee' }, 'employee_clock_in_method_check', { ifExists: true })
  pgm.dropColumn({ schema: 'onboarding', name: 'employee' }, 'clock_in_method')
}
