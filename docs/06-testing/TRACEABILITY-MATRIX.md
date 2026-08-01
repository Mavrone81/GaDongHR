# Requirement → Test Traceability Matrix (P0)
Format: PRD requirement → module test cases → cross-cutting suites → UAT pack. P1/P2 tracked in issue tracker at build time.

| PRD Req | Test cases | XC suites | UAT |
|---|---|---|---|
| M1-1 | TC-M1-001…004 | XC-CRYPTO, XC-RBAC | U2 |
| M1-2 | TC-M1-005…007, 016, 017 | XC-AUDIT | U2 |
| M1-3 | TC-M1-008…010 | XC-AUDIT | U2, U7 |
| M1-4 | TC-M1-011 | XC-I18N | U2, U8 |
| M1-5 | TC-M1-012, 013 | — | U2 |
| M2-1 | TC-M2-001 | — | U3 |
| M2-2 | TC-M2-002, 003, 012, 015 | XC-EVENTS, XC-RBAC | U3 |
| M2-3 | TC-M2-007, 008 | — | U3, U5 |
| M2-4 | TC-M2-004…006 | — | U3 |
| M2-5 | TC-M2-009…011 | — | U3 |
| M3-1 | TC-M3-001…005 | XC-EVENTS | U3 |
| M3-2 | TC-M3-006…009 | — | U3, U5 |
| M3-3 | TC-M3-010 | XC-AUDIT | U3 |
| M3-4 | TC-M3-011…014 | — | U5 |
| M3-5 | TC-M3-017 | XC-RBAC | U3 |
| M4-1 | TC-M4-001…003 | XC-CRYPTO | U2 |
| M4-2 | TC-M4-004, 005, 008 | — | U3 |
| M4-3 | TC-M4-006, 007 | — | U3 |
| M4-4 | TC-M3-015, TC-M4-011 | XC-EVENTS | U3 |
| M4-5 | TC-M4-010 | — | U3 |
| M4-6 | TC-M4-011, 012 | — | U3 |
| M4-7 | TC-M4-017 (gate), 016, 018 | XC-RBAC | — |
| M5-1 | TC-M5-001…005 | — | U4 |
| M5-2 | TC-M5-006, 007, 012, 015 | — | U4, U6 |
| M5-3 | TC-M5-008…010, 014 | — | U4 |
| M5-4 | TC-M5-011 | XC-EVENTS | U4 |
| M5-5 | TC-M5-013 | XC-I18N | U8 |
| M6-1 | TC-M6-001, 002 | — | U4 |
| M6-2 | TC-M6-003…005 | — | U4 |
| M6-3 | TC-M6-006, 007, 009 | XC-RBAC | U4 |
| M6-4 | TC-M6-010…013 | XC-EVENTS | U5 |
| M6-5 | TC-M6-008 | — | U4 |
| M7-1 | TC-M7-001 | — | U5 |
| M7-2 | TC-M7-002…010, 021, 022 | XC-CRYPTO | U5, U6 |
| M7-3 | TC-M7-011, 012, 015, 023 | XC-AUDIT | U5, U6 |
| M7-4 | TC-M7-016 | XC-I18N | U5, U8 |
| M7-5 | TC-M7-017 | — | U5 |
| M7-6 | TC-M7-018, 019 | XC-AUDIT | U5 |
| M7-7 | TC-M7-013, 014 | — | U6 |
| PRD §7.1 | XC-CRYPTO + XC-RBAC full matrices, TC-M4-016, TC-M7-011/015/022 | — | U7 |
| PRD §7.2 | XC-I18N sweep | — | U8 |
| PRD §7.3 | U1 install; TC-M4-011 (broker resilience); compose healthcheck suite | — | U1 |
| PRD §7.4 | TC-M5-001/004, TC-M7-003/004/021; config governance cases (svc-config integration suite) | XC-AUDIT | U6 |
| PRD §7.5 | TC-M3-016, TC-M7-020, k6 API suite, TC-M4-004 latency | — | U1 |
| PDPA §4/§7 | TC-M4-014/015/018, retention-job suite | XC-AUDIT | U7 |

Coverage rule: a P0 PRD requirement with no green row blocks release. Matrix is regenerated in CI from test annotations (`@verifies M7-2`) to prevent drift.
