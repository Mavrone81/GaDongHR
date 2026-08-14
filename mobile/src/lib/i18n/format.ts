/**
 * Every screen imports money/date formatting from HERE, never from
 * `./kernel/format` directly — this indirection is what lets
 * `./kernel/format.ts` stay a pristine, byte-for-byte copy of
 * `packages/kernel/src/i18n/format.ts` (see `./kernel/format.sync.test.ts`)
 * while still giving call sites a stable, mobile-owned import path.
 *
 * `toBuddhistEra`/`formatDate`/`formatTHB` are the kernel's own
 * satang-as-bigint and พ.ศ.-offset logic — never reimplemented here. See
 * `web/DESIGN.md`'s "Non-negotiables": "Buddhist Era and THB formatting
 * come from `@gadong/kernel`'s `i18n/format`."
 */
export { toBuddhistEra, formatDate, formatTHB } from './kernel/format';
export type { Locale } from './kernel/format';
