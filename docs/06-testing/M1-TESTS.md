# M1 Onboarding — Test Document
Refs: PRD M1-1…M1-5 · Module doc `../05-modules/M1-ONBOARDING.md` · Format: table cases; Pri P0 unless marked. Fixtures: Siam Test Co.

| ID | Verifies | Scenario / Steps | Expected |
|---|---|---|---|
| TC-M1-001 | M1-1 | POST /employees with valid Thai 13-digit ID | 201; bidx stored; DB row shows ciphertext only for 🔐 fields |
| TC-M1-002 | M1-1 | Invalid checksum ID | 422 ONB-001, i18n message in caller locale |
| TC-M1-003 | M1-1 | Second employee, same national ID (different formatting/spaces) | 409 ONB-002 via blind-index match |
| TC-M1-004 | M1-1 | Read profile as Manager vs HR | Manager: no sensitive fields, 403 on /sensitive; HR with employee.sensitive.read + purpose: fields decrypted, audit entry per field |
| TC-M1-005 | M1-2 | Create hire start date D | Checklist generated per type; SSO task due D+30 |
| TC-M1-006 | M1-2 | Clock to D+23 with SSO task open | Escalation notification to HR (mailhog + in-app) |
| TC-M1-007 | M1-2 | Complete SSO task without SSO number on record | Blocked ONB-030 |
| TC-M1-008 | M1-3 | Consent flow: accept HR notice, refuse biometric | Onboarding completes; alternative-method flag set; no adverse field anywhere in schema (schema assertion) |
| TC-M1-009 | M1-3 | Biometric consent bundled in same call as general | 422 ONB-020 (must be separate submission) |
| TC-M1-010 | M1-3 | Consent record content | Stores form version, lang shown, timestamp, full text snapshot (encrypted) |
| TC-M1-011 | M1-4 | Generate contract in th for zh-preferring employee with lang override | PDF renders Thai with พ.ศ. dates; stored ref against employee |
| TC-M1-012 | M1-5 | Probation end −14/−7 alerts | Notifications to manager+HR at both offsets (clock service) |
| TC-M1-013 | M1-5 | Probation terminate at day 121 of service | Severance calculator invoked, 30-day tier shown; at day 119 → no severance path |
| TC-M1-014 | §1.2 | Transition onboarding→active with incomplete checklist | 409 ONB-010 |
| TC-M1-015 | §1.2 | Terminate active employee | employee.terminated published; attendance consumes → template deletion (see TC-M4-014); leave payout event chain (TC-M5-012) |
| TC-M1-016 | XC | Self-service link token reuse after completion | 401; single-use enforced |
| TC-M1-017 | M1-2 | Upload EICAR file as document | Rejected by AV scan, audit security event |
| TC-M1-018 P1 | M1-7 | Bulk import 100 rows, 5 invalid | 95 created; validation report lists 5 with row/field/reason |
