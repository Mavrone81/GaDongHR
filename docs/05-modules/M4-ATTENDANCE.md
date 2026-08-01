# M4 — Facial Recognition Attendance: Module Design (Workflows · Classes · API)

| Field | Value |
|---|---|
| Service | `svc-attendance` (+ `compreface-*` engine) · schema `attendance` · base path `/api/attendance` |
| Version | 0.1 (Draft) · Date 2026-08-02 · Stage 3a |
| PRD refs | M4-1…M4-10 · PDPA doc §4–5 (consent, raw-image rules) · ADR-007 |

## 1. Workflows

### 1.1 Enrolment (M4-1) — consent-gated

```mermaid
flowchart TD
    A[Employee opens enrolment in ESS] --> B{Biometric consent = granted?<br/>from consent.granted event}
    B -- no --> Z[Blocked: show consent info<br/>+ alternative method setup PIN/QR]
    B -- yes --> C[Guided multi-angle capture<br/>quality checks: pose, light, single face]
    C --> D[svc-attendance → CompreFace<br/>create subject + add faces]
    D --> E[Store opaque face_subject_ref<br/>NO embedding in app schema]
    E --> F[Delete raw enrolment images<br/>≤7-day QA grace, default 0]
    F --> G[Enrolment active<br/>audit: enrolled_at]
    Z --> H[method = pin/qr — downstream identical]
```

### 1.2 Clock-in/out (M4-2/M4-3)

```mermaid
flowchart TD
    subgraph kiosk [Kiosk 1:N]
        K1[Camera frame in memory] --> K2[Passive liveness check]
        K2 -- fail --> KF[Security event<br/>frame kept encrypted ≤30d]
        K2 -- pass --> K3[CompreFace recognise 1:N]
        K3 -- score ≥ threshold --> OK
        K3 -- below --> KR[Retry ×2 → offer PIN/QR fallback]
    end
    subgraph pwa [Mobile PWA 1:1]
        M1[User logged in OIDC] --> M2[Active liveness challenge<br/>blink/turn prompt]
        M2 -- pass --> M3[CompreFace verify 1:1 vs own subject]
        M3 -- verified --> OK
    end
    OK[Accept punch] --> P[Build PunchEvent<br/>idem_key = device+seq]
    P --> Q{Broker reachable?}
    Q -- yes --> S[Publish attendance.punch]
    Q -- no --> L[Spool locally ≥24h<br/>kiosk IndexedDB / svc spool]
    L -- reconnect --> S
    S --> T[Timesheet consumes idempotently]
```

### 1.3 Consent withdrawal / termination — template deletion (PDPA §4.4)

```mermaid
sequenceDiagram
    participant O as svc-onboarding
    participant Q as rabbitmq
    participant A as svc-attendance
    participant F as CompreFace
    O->>Q: consent.withdrawn | employee.terminated
    Q-->>A: consume
    A->>F: DELETE subject(face_subject_ref)
    A->>F: GET subject (verify 404)
    A->>A: enrollment.status=deleted, template_deleted_at=now
    A->>Q: audit event: biometric.template.deleted (proof)
    Note over A: SLA ≤7 days (default: immediate)<br/>punch history retained (non-biometric facts)
    A->>A: auto-switch employee to PIN/QR method
```

## 2. Class Diagram

```mermaid
classDiagram
    class Enrollment {
      +UUID employeeId
      +Method method  // face|pin|qr|badge
      +String faceSubjectRef  // opaque
      +EnrollStatus status
      +Instant templateDeletedAt
      +activate() guard: consentGranted
      +deleteTemplate() verified
    }
    class Device {
      +DeviceKind kind
      +String siteCode
      +EncryptedField secret
      +register(approval)
      +authenticate(hmac)
    }
    class PunchEvent {
      +String idemKey
      +UUID employeeId
      +Instant punchedAt
      +Direction dir
      +Method method
      +Decimal matchScore
      +bool livenessPassed
    }
    class FaceEngineAdapter {
      <<interface>>
      +createSubject(ref)
      +addFace(ref, image)
      +recognize(image) Match[]
      +verify(ref, image) Score
      +deleteSubject(ref) verified
    }
    class ComprefaceAdapter { implements FaceEngineAdapter }
    class LivenessOrchestrator { +passiveCheck(frame) +activeChallenge(session) }
    class PunchSpool { +enqueue(event) +drainOnReconnect() // at-least-once }
    class ThresholdPolicy { +matchThreshold from config +retryLimit }
    Enrollment --> FaceEngineAdapter
    PunchEvent --> PunchSpool
    LivenessOrchestrator --> PunchEvent
    ComprefaceAdapter ..|> FaceEngineAdapter
    Device --> PunchEvent
```

`FaceEngineAdapter` is the swap point if CompreFace fails the ADR-007 benchmark (fallback: custom InsightFace service).

## 3. API Manual

Kiosk endpoints authenticate with per-device HMAC secret; human endpoints via OIDC.

| # | Method & Path | Permission | Description |
|---|---|---|---|
| 1 | `POST /enrolments/start` | self (ESS) | Guard: biometric consent granted → 409 `ATT-001` otherwise. Returns capture session |
| 2 | `POST /enrolments/{session}/frames` | self | Multipart frame(s); quality feedback; frames never persisted post-session |
| 3 | `POST /enrolments/{session}/complete` | self | Creates subject, stores ref, schedules raw deletion |
| 4 | `POST /enrolments/alternative` | self / `attendance.manage` | Set PIN or issue QR/badge (hashed storage) |
| 5 | `POST /punches/face` | device (kiosk) | Frame → liveness → 1:N recognise → punch. 200 `{employee, direction, ts}` / 422 `ATT-020` liveness / 404 `ATT-021` no match |
| 6 | `POST /punches/verify` | self (PWA) | Active-liveness session token + frame → 1:1 verify → punch |
| 7 | `POST /punches/code` | device/self | PIN/QR/badge punch — same PunchEvent shape (method-agnostic downstream) |
| 8 | `POST /punches/batch` | device | Spooled offline punches `[ {idemKey,...} ]` — idempotent replay safe |
| 9 | `GET /my/punches?from&to` | self | Own punch history (no scores shown) |
| 10 | `GET /devices` · `POST /devices` · `POST /devices/{id}/approve` | `attendance.device.manage` | Device registration with second-person approval |
| 11 | `GET /security-events?kind=liveness_failed` | `attendance.security.read` | Weekly review queue (PRD metric) |
| 12 | `DELETE /enrolments/{employeeId}/template` | system (events) / DPO | Verified engine deletion → audit proof |

### Events

| Direction | Event | Payload |
|---|---|---|
| out | `attendance.punch` | employeeId, ts, direction, method, site, deviceId, matchScore?, idemKey |
| out | `attendance.liveness_failed` | deviceId, ts, site (no image in event) |
| out | `biometric.template.deleted` | employeeId, verifiedAt (audit proof) |
| in | `consent.granted/withdrawn`, `employee.terminated` | gate enrolment / trigger deletion |

### Error codes (extract)
`ATT-001` enrolment without biometric consent · `ATT-010` capture quality insufficient · `ATT-020` liveness failed · `ATT-021` no match ≥ threshold · `ATT-022` multiple faces (kiosk anti-tailgating) · `ATT-030` device not approved / bad HMAC · `ATT-040` duplicate idemKey (already processed → 200 replay-safe).

## 4. Non-Functional Targets
Match p50 ≤ 2 s end-to-end (CPU); FAR ≤ 0.1% at configured threshold (benchmark gate, ADR-007); kiosk offline ≥ 24 h; punch burst 10/s; zero raw-image persistence on success path (verified by test).

## 5. Test Hooks
Photo/video replay rejected by liveness suite; consent-withdrawal deletes subject with 404 verification + audit proof while punch history remains; offline spool replay produces no duplicates in Timesheet; PIN fallback event shape identical to face; device with revoked secret rejected; two faces in kiosk frame → `ATT-022`, no punch.
