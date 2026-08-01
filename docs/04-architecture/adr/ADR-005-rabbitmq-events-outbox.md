# ADR-005: RabbitMQ topic events + transactional outbox + idempotent consumers
- Status: Accepted · Date: 2026-08-02
## Context
Attendance→timesheet→payroll pipeline must lose zero events (PRD M4-4 AC) across container restarts on one host.
## Decision
RabbitMQ 3.13 quorum queues, topic exchange `gadong.events`. Producers write events to a per-schema `outbox` table in the same transaction as state, a relay publishes; consumers dedupe via `processed_events`. Events carry no S3 plaintext.
## Alternatives
Kafka/Redpanda (heavier ops for the target size), Postgres LISTEN/NOTIFY (no durable fan-out).
## Consequences
+ At-least-once with exactly-once effect; broker restart-safe.
− Outbox relay adds a moving part — shipped inside @gadong/kernel with metrics.
