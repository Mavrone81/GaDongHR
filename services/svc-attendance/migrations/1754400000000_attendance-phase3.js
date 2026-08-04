'use strict'

/**
 * Phase 3 additions to the `attendance` schema (M4 build — enrolment,
 * liveness clock-in, the alternative method, and the punch pipeline). The
 * Task 14 skeleton migration (`1754300000000_attendance-schema.js`) already
 * shaped `enrollment`/`device`/`punch_event`/`attendance_employee_ref` plus
 * the standard `outbox`/`processed_events` pair — this file only ADDS what
 * that skeleton deliberately left out because there was no business logic
 * yet to back it:
 *
 *   attendance.biometric_consent — a read model fed by `consent.granted`/
 *     `consent.withdrawn` (svc-onboarding, consumed idempotently). M4-1 is
 *     "technically impossible until explicit biometric consent exists" —
 *     that gate has to check SOMETHING, and this service owns no row in
 *     `onboarding.consent_record` (cross-schema queries are disallowed by
 *     convention). This table is that something: one row per employee,
 *     current state only (the full consent history of grant/refuse/
 *     withdraw lives in `onboarding.consent_record` — this table is not a
 *     second copy of that ledger, just the current fact this service's
 *     enrolment gate and template-deletion trigger need to act on).
 *
 *   attendance.alternative_credential — PIN/QR/badge credential storage for
 *     M4-5 (PDPA-BIOMETRIC-COMPLIANCE.md §4.2: "the system always offers an
 *     equivalent alternative clock-in method"). `credential_hash` is a
 *     salted-pepper HMAC, never the raw PIN/QR/badge code — see
 *     `credential-hash.ts`. UNIQUE so a scanned QR/badge code resolves to
 *     exactly one employee (`findByHash`); a PIN punch instead supplies
 *     `employeeId` directly (the punch flow already knows who is standing
 *     at the kiosk) and this table is only used to verify the PIN they
 *     typed, so PIN collisions across employees — which the UNIQUE
 *     constraint would otherwise forbid — are avoided by scoping every PIN
 *     hash with the employee id inside the hashed material itself
 *     (`credential-hash.ts`'s `hashCredential`), not by relaxing this
 *     constraint.
 *
 *   attendance.security_event — M4-3's "failed liveness logs a security
 *     event" and M4-9's anti-tailgating multi-face log, queried by
 *     `GET /security-events?kind=liveness_failed` (M4-ATTENDANCE.md API
 *     manual row 11). Deliberately carries NO frame/image data — the module
 *     doc's kiosk flow keeps a failed-liveness frame "encrypted ≤30 days"
 *     as an operational/ops-console concern outside this table; what this
 *     service's own audit surface needs is the FACT that a liveness check
 *     failed, not the pixels.
 *
 *   attendance.device — three columns added for M4's documented
 *     "second-person approval" (module doc §3, row 10): `registered_by`,
 *     `approved_by`, `approved_at`. `device_status_check` is added now
 *     because Phase 2 never declared one (any text was accepted); Phase 3
 *     is the first code that actually writes `status` transitions
 *     (`pending` → `active`/`revoked`), so this is the first point a CHECK
 *     constraint has real business meaning to enforce.
 *
 * Not executed against a real Postgres in this environment (no Postgres
 * here — matching every prior migration's documented deferral); a later
 * integration task re-proves this against real Postgres.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'attendance', name: 'biometric_consent' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      state: { type: 'text', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true },
    },
  )
  pgm.addConstraint({ schema: 'attendance', name: 'biometric_consent' }, 'biometric_consent_state_check', {
    check: "state IN ('granted', 'withdrawn')",
  })

  pgm.createTable(
    { schema: 'attendance', name: 'alternative_credential' },
    {
      employee_id: { type: 'uuid', primaryKey: true },
      kind: { type: 'text', notNull: true },
      // 🔐-shaped by convention (bytea) even though this is a keyed HMAC,
      // not `svc-crypto` envelope ciphertext — see the file header and
      // `credential-hash.ts`. Never the raw PIN/QR/badge code.
      credential_hash: { type: 'bytea', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint({ schema: 'attendance', name: 'alternative_credential' }, 'alternative_credential_kind_check', {
    check: "kind IN ('pin', 'qr', 'badge')",
  })
  pgm.addConstraint(
    { schema: 'attendance', name: 'alternative_credential' },
    'alternative_credential_hash_key',
    { unique: ['credential_hash'] },
  )

  pgm.createTable(
    { schema: 'attendance', name: 'security_event' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      kind: { type: 'text', notNull: true },
      device_id: { type: 'uuid', references: { schema: 'attendance', name: 'device' }, referencesConstraintName: 'security_event_device_id_fkey' },
      employee_id: { type: 'uuid' },
      site_code: { type: 'text', notNull: true },
      at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
  )
  pgm.addConstraint({ schema: 'attendance', name: 'security_event' }, 'security_event_kind_check', {
    check: "kind IN ('liveness_failed', 'multi_face')",
  })
  pgm.createIndex({ schema: 'attendance', name: 'security_event' }, ['kind', 'at'])

  pgm.addColumns(
    { schema: 'attendance', name: 'device' },
    {
      registered_by: { type: 'uuid' },
      approved_by: { type: 'uuid' },
      approved_at: { type: 'timestamptz' },
    },
  )
  pgm.addConstraint({ schema: 'attendance', name: 'device' }, 'device_status_check', {
    check: "status IN ('pending', 'active', 'revoked')",
  })
}

exports.down = (pgm) => {
  pgm.dropConstraint({ schema: 'attendance', name: 'device' }, 'device_status_check', { ifExists: true })
  pgm.dropColumns({ schema: 'attendance', name: 'device' }, ['registered_by', 'approved_by', 'approved_at'])
  pgm.dropTable({ schema: 'attendance', name: 'security_event' })
  pgm.dropTable({ schema: 'attendance', name: 'alternative_credential' })
  pgm.dropTable({ schema: 'attendance', name: 'biometric_consent' })
}
