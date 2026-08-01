# ADR-006: Keycloak for authentication (OIDC), custom svc-authz for fine-grained RBAC
- Status: Accepted · Date: 2026-08-02
## Context
Need OIDC login, MFA option, password policy, kiosk device auth — and org-scoped, SoD-aware permissions that Keycloak's authz model expresses poorly.
## Decision
Keycloak 26 authenticates humans (and issues service tokens); roles/permissions/org-scoping/SoD live in svc-authz (decision API + policy data in `authz` schema), evaluated by a shared guard in every service. Step-up re-auth for payroll approve/exports.
## Consequences
+ Best-of-both: standard auth, precise domain authz, testable RBAC matrix.
− Two sources to keep in sync (user list) — Keycloak is master for identities, svc-authz for grants, synced by events.
