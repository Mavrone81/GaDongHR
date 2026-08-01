# ADR-001: Docker Compose on a single host as the complete deployment
- Status: Accepted · Date: 2026-08-02
## Context
Requirement: system fully built and run via Docker Compose; target 50–500 (max 1,000) employees per deployment; self-hosted by customers without platform teams.
## Decision
One `docker-compose.yml` (+ dev/prod overrides, optional `observability` profile) runs every component on a single host. No Kubernetes, no managed-cloud dependencies.
## Consequences
+ <60-min install goal achievable; auditable, air-gappable deployments.
− Single-host availability ceiling (99.5% target); vertical scaling only. DB/broker are the limits — acceptable at target size.
- Compose service names/networks become the stable service-discovery contract.
