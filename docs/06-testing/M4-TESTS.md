# M4 Facial Attendance — Test Document
Refs: PRD M4-1…M4-9 · `../05-modules/M4-ATTENDANCE.md` · Synthetic consented face set only.

| ID | Verifies | Scenario / Steps | Expected |
|---|---|---|---|
| TC-M4-001 | M4-1 | Start enrolment without biometric consent | 409 ATT-001; alternative setup offered |
| TC-M4-002 | M4-1 | Full enrolment happy path | Subject created; app schema stores opaque ref only (schema assertion: no embedding/bytes); raw frames absent after completion (storage scan) |
| TC-M4-003 | M4-1 | Low-quality frames (dark/multi-face) | ATT-010 with guidance; retake loop |
| TC-M4-004 | M4-2 | Kiosk 1:N match enrolled user | ≤2s p50; punch created; score ≥ threshold logged |
| TC-M4-005 | M4-2 | Unenrolled face at kiosk | ATT-021 after retries; PIN fallback offered; no punch |
| TC-M4-006 | M4-3 | Printed photo of enrolled user at kiosk | Liveness fail ATT-020; security event; frame retained encrypted; auto-purged ≤30d (clock service) |
| TC-M4-007 | M4-3 | Video replay on PWA (active challenge) | Challenge mismatch → fail |
| TC-M4-008 | M4-2 | PWA 1:1: logged-in user A presents face of enrolled user B | Verify fails (1:1 against own subject only) |
| TC-M4-009 | M4-9 | Two faces in kiosk frame | ATT-022; no punch; both logged |
| TC-M4-010 | M4-5 | PIN punch for consent-refuser | attendance.punch identical shape (method=pin); Timesheet agnostic |
| TC-M4-011 | M4-6 | Kill broker 1h during kiosk punching; reconnect | Spool drains; /punches/batch idempotent; 0 loss/dupe in Timesheet |
| TC-M4-012 | M4-6 | Kiosk fully offline 24h | Local capture continues; replay complete |
| TC-M4-013 | Device | Punch with revoked device secret / unapproved device | 401/403 ATT-030 |
| TC-M4-014 | PDPA §4.4 | Withdraw consent | Subject DELETE + 404 verification; enrollment.deleted + template_deleted_at set; biometric.template.deleted audit proof; auto-switch to PIN; punch history intact |
| TC-M4-015 | PDPA | employee.terminated event | Same deletion chain within SLA |
| TC-M4-016 | XC-RBAC | Every human role calls any hypothetical template-read route | No such permission exists; 403/404 for all — asserted from permission catalog |
| TC-M4-017 | ADR-007 gate | Benchmark: synthetic Thai/Chinese face set, N=size per protocol | FAR ≤0.1% at threshold; FRR within target; CPU p50 ≤2s — release gate for M4 |
| TC-M4-018 | Success path privacy | Storage scan after 100 successful punches | Zero persisted frames |
