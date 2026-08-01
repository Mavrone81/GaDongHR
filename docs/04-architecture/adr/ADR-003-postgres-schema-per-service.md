# ADR-003: PostgreSQL 16, one instance, schema-per-service (split-ready); MinIO for files; Redis for cache
- Status: Accepted · Date: 2026-08-02
## Context
Microservices purism (DB per service) vs single-host reality. Services must not share tables; ops must stay simple (one backup, one engine).
## Decision
One PostgreSQL 16 instance; each service gets its own schema and its own DB role with GRANTs limited to that schema. No cross-schema queries permitted. Connection strings are per-service, so any schema can later move to its own instance without code change. MinIO stores files (payslips, receipts, contracts — encrypted); Redis for sessions/cache only (no source-of-truth data).
## Consequences
+ Service isolation preserved logically; single pg_dump backup; upgrade one engine.
− A runaway service can pressure shared DB resources — mitigated with per-role connection limits and statement timeouts.
