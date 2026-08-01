# ADR-008: Single React PWA (ESS/manager/admin/kiosk modes); server-side HTML→PDF with embedded Thai/CJK fonts
- Status: Accepted · Date: 2026-08-02
## Context
v1 has no native apps (PRD Non-Goal 4); camera-based clock-in must work in mobile browsers; documents must render Thai (incl. B.E. dates) and Simplified Chinese correctly.
## Decision
React+Vite PWA, react-i18next (th/en/zh bundles from svc-i18n), role-driven navigation, kiosk route in fullscreen locked mode, getUserMedia for capture, offline punch queue (IndexedDB) for kiosk. svc-docs renders documents from HTML templates via headless Chromium with embedded Sarabun + Noto Sans SC; dates localised (B.E. on th).
## Consequences
+ One frontend codebase; PWA installable on kiosk tablets.
− Browser camera constraints vary — kiosk hardware list documented in runbook; native apps remain a fast-follow.
