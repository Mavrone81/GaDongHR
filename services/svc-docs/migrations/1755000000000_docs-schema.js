'use strict'

/**
 * `docs` schema — task brief exactly:
 *
 *   docs.document(id uuid pk, kind text, entity_type text, entity_id text,
 *                 lang text, file_ref bytea, sha256 text, created_at timestamptz)
 *
 * `file_ref` is `bytea`, not `text`, because it holds the envelope-encrypted
 * MinIO pointer (bucket + object key), never a plaintext path — an S3-class
 * field per the roadmap's data-classification contract (same treatment
 * `svc-crypto`'s ciphertext columns get; see `documents.service.ts`'s
 * `prepare()`, which encrypts the pointer via kernel `CryptoClient` before
 * this column is ever written, and never writes a plaintext fallback —
 * `cryptoUnavailable()` aborts the whole render instead).
 *
 * Plus the two tables every schema carries: `outbox` and
 * `processed_events(event_id PK)` (global-constraints; roadmap "Database
 * conventions") — `document.rendered` events are written to `outbox` in the
 * same transaction as the `document` row (`DocumentsService.commit()`, ADR-005).
 * `gen_random_uuid()` is built into Postgres core since 13 — no `pgcrypto`
 * extension needed on Postgres 16.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — CONSTRAINTS); a later integration task runs this for real, the
 * same deferred verification `services/svc-config`'s migration notes.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createSchema('docs', { ifNotExists: true })

  pgm.createTable(
    { schema: 'docs', name: 'document' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      kind: { type: 'text', notNull: true },
      entity_type: { type: 'text', notNull: true },
      entity_id: { type: 'text', notNull: true },
      lang: { type: 'text', notNull: true },
      file_ref: { type: 'bytea', notNull: true },
      sha256: { type: 'text', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  // The common read pattern is "every document of kind K for entity E" —
  // e.g. every payslip issued to one employee.
  pgm.createIndex({ schema: 'docs', name: 'document' }, ['entity_type', 'entity_id', 'kind'])

  pgm.createTable(
    { schema: 'docs', name: 'outbox' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      topic: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    },
  )
  pgm.createIndex(
    { schema: 'docs', name: 'outbox' },
    ['created_at'],
    { name: 'outbox_unpublished_idx', where: 'published_at IS NULL' },
  )

  // `event_id PK` — without it dedupe silently degrades to a no-op (matching
  // every other schema's `processed_events` table).
  pgm.createTable(
    { schema: 'docs', name: 'processed_events' },
    {
      event_id: { type: 'text', primaryKey: true },
      processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
}

exports.down = (pgm) => {
  pgm.dropSchema('docs', { cascade: true, ifExists: true })
}
