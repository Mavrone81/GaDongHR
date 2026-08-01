# ADR-002: Node.js 22 + TypeScript (NestJS) for all module & platform services
- Status: Accepted · Date: 2026-08-02
## Context
Seven module services + platform services; small team; shared conventions (authz middleware, crypto client, outbox, i18n) must be reusable; face engine is a separate off-the-shelf container.
## Decision
Single language/framework: NestJS (TypeScript) with a shared internal library (`@gadong/kernel`) providing crypto client, event bus (outbox/idempotency), authz guard, config client, audit emitter. OpenAPI generated per service.
## Alternatives
Go (better footprint, more boilerplate for team), per-service polyglot (rejected: operational cost). Python considered only for face work — avoided by using CompreFace (ADR-007).
## Consequences
+ One toolchain, shared kernel enforces security patterns uniformly.
− Node memory footprint × ~15 containers — mitigated by 16 GB host sizing and lazy modules.
