# GaDongHR — UAT Plan & Parallel Payroll Run

| Field | Value |
|---|---|
| Version | 0.1 (Draft) · Date 2026-08-02 |
| Participants | Pilot customer: HR Officer, Payroll Officer, Payroll Approver, 2 Line Managers, 10 employees (incl. th/en/zh speakers, 1 biometric-refusal), DPO, IT admin |
| Environment | Customer-hosted compose install (validates <60-min install metric) with production-like data subset |

## 1. UAT Scenario Packs (each = scripted checklist, pass/fail + comments)
| Pack | Persona | Covers |
|---|---|---|
| U1 Install & setup | IT admin | Fresh `docker compose up`, Vault init ceremony, seed packs, admin bootstrap — timed |
| U2 Onboard a hire | HR | Full M1 flow incl. separate biometric consent + one refusal path; SSO D+30 task visible |
| U3 Roster & punch week | Manager + employees | Publish roster; face kiosk + PWA punches; one PIN user; forced offline hour on kiosk; late + missed-punch exceptions resolved |
| U4 Leave & claims | Employees + manager | Sick 3-day cert rule; annual leave collision warning on roster; claim ≤/> 2,000 THB bands; rejection+resubmit |
| U5 Month-end | HR + Payroll pair | Lock period (blocked by open exception first), calculate, variance review, SoD approve (self-approve attempt must fail), commit, payslips th/en/zh, bank file, สปส.1-10 + PND 1 exports |
| U6 Special cases | Payroll | Final pay with severance tier; adjustment run; infant-care 50% day; EWF date-gate demo (clock service) |
| U7 DPO console | DPO | Consent withdrawal → template deletion proof; DSAR export; retention queue review |
| U8 Language sweep | zh & th users | Complete U2–U5 touchpoints entirely in zh and th |

## 2. Parallel Payroll Run Protocol
Two consecutive real months computed in GaDongHR alongside incumbent process. Run 1 target: net-pay line variance ≤0.5%, all variances explained & classified (config vs incumbent-error vs defect). Run 2 target: zero unexplained variances. Incumbent remains system of record until sign-off.

## 3. Acceptance & Sign-off
UAT passes when: 100% of U1–U8 P0 steps pass; parallel-run targets met; install ≤60 min; no open Sev-1/2; DPO signs PDPA checklist (consent, deletion proof, DSAR, breach playbook walkthrough); Payroll Approver signs statutory-output spot-check vs accountant recomputation for 5 sampled employees. Sign-off recorded in repo (`docs/06-testing/signoff/`).
