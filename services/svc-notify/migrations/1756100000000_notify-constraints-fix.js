'use strict'

/**
 * Fixes Task 16c's defect for `notify`. `1754200000000_notify-schema.js`
 * declared every CHECK on `notification`, `delivery`, and `recipient_pref`
 * as `{ constraints: { <chosen_name>: { check: '...' } } }` — a constraint
 * NAME nested one level inside `options.constraints`, not one of the KINDS
 * (`check`/`unique`/`primaryKey`/`foreignKeys`/`exclude`) node-pg-migrate
 * 7.9.1's `parseConstraints` (`dist/operations/tables/shared.js`) actually
 * destructures off that object. A nested, arbitrarily-named key is invisible
 * to it, so `CREATE TABLE` ran and silently produced none of these five
 * CHECK constraints — same bug, same silent failure mode as `svc-authz`'s
 * live finding (Task 16c).
 *
 * `1754200000000_notify-schema.js` itself is deliberately NOT edited here:
 * `notify` is one of the seven platform services in
 * `deploy/docker-compose.prod.yml` (deployed at Task 16), so that migration
 * already ran on `gadonghr-prod` and editing it changes nothing there —
 * node-pg-migrate never re-runs a migration once its name is recorded in
 * `pgmigrations`. It also must not be "corrected" in place: a brand-new
 * environment replays every migration from scratch, and if the parent
 * migration created these constraints AND this one also tried to,
 * `pgm.addConstraint` would fail with "constraint already exists". Leaving
 * the parent exactly as it is (the same no-op it always was) and creating
 * them here, once, keeps prod and every fresh environment consistent.
 *
 * No de-duplication needed here (unlike `svc-authz`/`svc-config`'s
 * UNIQUE/PRIMARY KEY fixes): CHECK constraints don't require rows to be
 * mutually distinct, only individually valid, and every value in these five
 * checks' enumerated vocabularies has only ever been written by application
 * code that already used exactly these values — if the live tables somehow
 * hold a row violating one of these (which would mean the application wrote
 * a value outside its own documented vocabulary), this migration fails
 * loudly rather than silently accepting it, which is the correct behaviour
 * for a data-quality control that was never actually enforced.
 *
 * What each constraint protects: all five are data-quality controls, not
 * security or correctness-critical ones on their own — enumerated
 * vocabularies for `notification.lang` / `recipient_pref.lang` (the three
 * locales this product ships, `packages/kernel/src/i18n/format.ts`'s
 * `Locale`), `delivery.channel`, and `delivery.status` — but the absence of
 * ALL of them meant nothing at the database stopped a typo'd or
 * bogus-channel row from being written, silently corrupting reporting and
 * retry logic that assumes these are closed vocabularies.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.addConstraint(
    { schema: 'notify', name: 'notification' },
    'notification_lang_check',
    { check: "lang IN ('th', 'en', 'zh')" },
  )
  pgm.addConstraint(
    { schema: 'notify', name: 'delivery' },
    'delivery_channel_check',
    { check: "channel IN ('in_app', 'email')" },
  )
  pgm.addConstraint(
    { schema: 'notify', name: 'delivery' },
    'delivery_status_check',
    { check: "status IN ('sent', 'failed')" },
  )
  pgm.addConstraint(
    { schema: 'notify', name: 'recipient_pref' },
    'recipient_pref_lang_check',
    { check: "lang IN ('th', 'en', 'zh')" },
  )
}

exports.down = (pgm) => {
  pgm.dropConstraint({ schema: 'notify', name: 'recipient_pref' }, 'recipient_pref_lang_check')
  pgm.dropConstraint({ schema: 'notify', name: 'delivery' }, 'delivery_status_check')
  pgm.dropConstraint({ schema: 'notify', name: 'delivery' }, 'delivery_channel_check')
  pgm.dropConstraint({ schema: 'notify', name: 'notification' }, 'notification_lang_check')
}
