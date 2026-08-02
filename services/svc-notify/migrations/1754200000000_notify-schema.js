'use strict'

/**
 * `notify` schema — Task 11 brief, exactly:
 *
 *   notify.notification(id uuid pk, recipient_user_id uuid, kind text, lang text,
 *                        subject text, body text, read_at timestamptz null,
 *                        created_at timestamptz)
 *   notify.delivery(id uuid pk, notification_id uuid, channel text, status text,
 *                    attempts int, last_error text null, sent_at timestamptz null)
 *
 * Plus `processed_events(event_id PK)` (roadmap "Database conventions"). No
 * `outbox` table: this service is a pure event CONSUMER (Task 11 brief) — it
 * emits nothing, so there is nothing for `OutboxRelay` to drain.
 *
 * `notify.recipient_pref` is NOT in the brief's schema listing above — it is
 * added here, and the deviation is deliberate and load-bearing, not scope
 * creep. The brief's own compliance bar is "Language is the RECIPIENT's, not
 * the actor's" for `leave.approved` and `claim.approved_for_payroll`, but
 * neither payload carries a language (roadmap "Event catalog":
 * `{requestId, employeeId, leaveTypeCode, dates, days, payMode}` and
 * `{claimId, employeeId, amountThb, claimType}` — no `lang` field on
 * either). The only event in this consumer's list that carries a language
 * at all is `employee.created`'s `preferredLang`. Answering "what language
 * does employeeId X read in" at `leave.approved` time is therefore only
 * possible if this service already knows it — the same reasoning, and the
 * same shape, as `svc-authz`'s `org_unit` local read model built from the
 * same `employee.created` event (Task 8): "No foreign keys across schemas,
 * no cross-schema queries" (roadmap "Database conventions") forces every
 * consumer to keep its own copy of anything it needs from another
 * service's data rather than querying for it live.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — Task 11 brief, carried-forward binding); Task 13b re-proves this
 * against real Postgres, matching Tasks 4, 7, and 8.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('notify', { ifNotExists: true })

  pgm.createTable(
    { schema: 'notify', name: 'notification' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      recipient_user_id: { type: 'uuid', notNull: true },
      kind: { type: 'text', notNull: true },
      lang: { type: 'text', notNull: true },
      subject: { type: 'text', notNull: true },
      body: { type: 'text', notNull: true },
      read_at: { type: 'timestamptz' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        // The three locales this product ships (packages/kernel/src/i18n/format.ts's `Locale`).
        notification_lang_check: { check: "lang IN ('th', 'en', 'zh')" },
      },
    },
  )
  // Backs `GET /notifications?unread=true` (self-scoped, ordered newest first) and its non-filtered sibling.
  pgm.createIndex({ schema: 'notify', name: 'notification' }, ['recipient_user_id', 'created_at'])
  pgm.createIndex(
    { schema: 'notify', name: 'notification' },
    ['recipient_user_id'],
    { name: 'notification_unread_idx', where: 'read_at IS NULL' },
  )

  pgm.createTable(
    { schema: 'notify', name: 'delivery' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      notification_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'notify', name: 'notification' },
        referencesConstraintName: 'delivery_notification_id_fkey',
        onDelete: 'CASCADE',
      },
      channel: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true },
      attempts: { type: 'integer', notNull: true, default: 1 },
      last_error: { type: 'text' },
      sent_at: { type: 'timestamptz' },
    },
    {
      constraints: {
        delivery_channel_check: { check: "channel IN ('in_app', 'email')" },
        delivery_status_check: { check: "status IN ('sent', 'failed')" },
      },
    },
  )
  pgm.createIndex({ schema: 'notify', name: 'delivery' }, ['notification_id'])

  // Local read model of `employee.created`'s `preferredLang` — see file
  // header comment for why this table exists at all.
  pgm.createTable(
    { schema: 'notify', name: 'recipient_pref' },
    {
      user_id: { type: 'uuid', primaryKey: true },
      lang: { type: 'text', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        recipient_pref_lang_check: { check: "lang IN ('th', 'en', 'zh')" },
      },
    },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (roadmap "Database conventions").
  pgm.createTable(
    { schema: 'notify', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  pgm.dropSchema('notify', { cascade: true, ifExists: true })
}
