# ADR-004: Field-level envelope encryption via Vault Transit + svc-crypto; HMAC blind indexes
- Status: Accepted · Date: 2026-08-02
## Context
Hard requirement: data encrypted before entering the database; DB dump must reveal no sensitive plaintext; searchable fields (national ID, email) still need exact-match lookup; PDPA crypto-erasure needed.
## Decision
Per-class master keys (KEKs) live in Vault Transit; per-record AES-256-GCM data keys wrapped by KEKs; ciphertext blob = wrappedDEK∥nonce∥ct∥tag with AAD = entity+field. `svc-crypto` is the only Vault client and exposes encrypt/decrypt/HMAC. Exact-match search via HMAC-SHA256 blind index columns. Postgres TDE/pgcrypto rejected (server-side = plaintext reaches DB / weak key handling); per-service local keys rejected (rotation/audit weaker).
## Consequences
+ Meets encrypt-before-write literally; rotation via key versions; crypto-erasure enables PDPA deletion.
− No LIKE/range search on encrypted fields (accepted; UI searches read-model name/code). Vault sealed ⇒ S3 ops fail closed. Unseal ceremony is operational overhead — documented in runbook.
