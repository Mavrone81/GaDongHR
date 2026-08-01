# ADR-007: CompreFace (self-hosted) as facial recognition engine
- Status: Accepted · Date: 2026-08-02
## Context
Face matching must run fully inside the Compose deployment (no cloud APIs, PDPA), CPU-only default hardware, and expose enrol/verify/recognise APIs. Candidates: CompreFace, custom InsightFace service, DeepFace.
## Decision
CompreFace (Apache-2.0, InsightFace models, REST API, Docker-native) as engine container(s); svc-attendance is the only client and owns consent gating, liveness challenge orchestration (PWA active liveness; kiosk passive model), thresholds, and deletion verification. Templates stay inside CompreFace's storage (encrypted volume), referenced by opaque subject ids.
## Open validation (PRD Q2)
Benchmark FAR/FRR on Thai/Chinese face sets and CPU latency (<2 s p50) before M4 exit; fallback plan = custom InsightFace microservice with same internal API.
## Consequences
+ Fast to integrate, self-hosted, replaceable behind an internal adapter interface.
− Liveness not built-in → implemented at capture layer; engine accuracy must be validated (Q2).
