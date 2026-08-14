# GaDongHR — Build Program Roadmap

**Decided 2026-08-02:** build all 15 services real and wired (P0 logic; P1/P2 deferred), platform first, then M1→M7 in the PRD's dependency order, deploying after each phase.

**Target host:** `gadonghr-prod` · `157.230.38.96` · sgp1 · 2 vCPU / 4 GB / 80 GB · Bevora DO account. Serves `hr.bevorasg.com` (A record currently still points at 165 — cut over in Phase 1).

---

## Service inventory

Fifteen services plus the frontend. Every one is NestJS on Node 22, owns exactly one Postgres schema, and consumes `@gadong/kernel`.

| # | Service | Schema | Owns | Phase |
|---|---|---|---|---|
| — | `@gadong/kernel` | — | crypto client, outbox, idempotency, authz guard, audit emitter, i18n helper, effective-date resolver | 1 |
| 1 | `svc-crypto` | — | Vault Transit envelope encryption, blind indexes; only Vault client | 1 |
| 2 | `svc-config` | `config` | effective-dated statutory rules, governance workflow, seed packs, feature flags | 1 |
| 3 | `svc-authz` | `authz` | permission catalog, roles, org-scoped grants, SoD checks | 1 |
| 4 | `svc-audit` | `audit` | hash-chained append-only log, chain verification | 1 |
| 5 | `svc-i18n` | — | th/en/zh bundles, fallback, glossary | 1 |
| 6 | `svc-notify` | `notify` | in-app + email, per-recipient language | 1 |
| 7 | `svc-docs` | `docs` | HTML→PDF with Sarabun + Noto Sans SC, B.E. dates, MinIO storage | 1 |
| 8 | `svc-onboarding` | `onboarding` | M1 — employees, documents, consents, probation, checklists | 2 |
| 9 | `svc-scheduler` | `scheduler` | M2 — shifts, rosters, holidays, OT pre-approval | 3 |
| 10 | `svc-attendance` | `attendance` | M4 — enrolment, CompreFace, liveness, punch events | 3 |
| 11 | `svc-timesheet` | `timesheet` | M3 — day records, OT classification, exceptions, period locks | 3 |
| 12 | `svc-leave` | `leave` | M5 — types, accrual, balances, approval chains | 4 |
| 13 | `svc-claims` | `claims` | M6 — types, receipts, banded approval, reimbursement routing | 4 |
| 14 | `svc-payroll` | `payroll` | M7 — pay profiles, gross-to-net, payslips, statutory exports, final pay | 5 |
| 15 | `retention-job` | — | nightly PDPA retention → DPO queue → crypto-erasure | 5 |
| — | `web` | — | React PWA: ESS, manager, admin, DPO, kiosk | 2–5 |

## Phases

| Phase | Plan | Contents | Exit criteria |
|---|---|---|---|
| **1** | `01-foundation-platform.md` | Monorepo, kernel, services 1–7, all 15 service skeletons, CI→GHCR, first deploy | `https://hr.bevorasg.com` live; a field encrypts through Vault and a DB dump shows no plaintext; RBAC denies by default; audit chain verifies |
| **1.5** | `015-pwa-shell.md` | React PWA shell: Keycloak login, role-driven nav, th/en/zh, ESS screens against real `svc-config`/`svc-authz`, payslip on fixtures | Someone can log in and click through a Thai-language product with live statutory citations — the first demoable milestone |
| **2** | `02-m1-onboarding.md` | M1 Onboarding, wired into the existing shell | A new hire is onboarded with separate biometric consent, refusal path works, SSO D+30 task exists |
| **3** | `03-time-capture.md` | M2 Scheduler, M4 Attendance, M3 Timesheet | Punch → timesheet with zero loss across a broker restart; OT classified into 1.5×/2×/3× |
| **4** | `04-requests.md` | M5 Leave, M6 Claims | Statutory leave defaults pass floor validation; banded claim approval in three languages |
| **5** | `05-payroll.md` | M7 Payroll, retention job, statutory exports | Golden-file payroll fixtures pass across all three rule-pack windows; SoD blocks self-approval |
| **6** | `06-hardening.md` | Pen test, PDPA audit, k6 load, restore drill, RBAC matrix generation | Security doc §8 checklist complete |

Each phase's plan is written just before it starts, against the code that then exists. Writing Phase 5's tasks today would guarantee they are wrong.

## Phase 1.5 exists to be demoable early — and must not become rework

Added 2026-08-02 at Samuel's request: a clickable prototype well before the sequential path would
produce one. The standing risk with a shell built ahead of its modules is that it becomes a
throwaway demo someone later has to rewrite. Three rules make it real code instead:

1. **It talks to real services, not mocks.** Login goes through Keycloak. Leave balances and their
   LPA citations come from `svc-config` over HTTP. Permissions come from `svc-authz`. Anything that
   cannot be real yet — payslip figures, punch history — is a clearly-labelled fixture behind the
   *same* API client the real service will use, so wiring M1 through is a URL change, not a rewrite.
2. **No UI-side business logic, ever.** No statutory value, OT multiplier, tax bracket or accrual
   rule is computed in the frontend. Buddhist Era rendering and THB formatting come from
   `@gadong/kernel`'s `i18n/format`, not a second implementation in React.
3. **i18n keys from day one.** Every string goes through `svc-i18n` bundles. A demo with hard-coded
   Thai strings is precisely the thing that has to be rewritten, and it is the most common way this
   kind of shell rots.

## Every endpoint has a front end — enforced, not intended

Standing rule, set 2026-08-03 at Samuel's instruction: **no user-facing endpoint ships without a
corresponding screen**, and the mapping is checked by CI rather than remembered.

The mechanism is `web/ui-coverage.json`: a manifest listing every HTTP route in the system against
either the screen route that surfaces it, or an explicit exemption with a reason. A test enumerates
the actual `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` decorators across `services/**/*.controller.ts`
and fails when a route appears in the code but not the manifest. Adding an endpoint therefore forces
a deliberate decision about where a human sees it — the failure mode this prevents is a backend
capability nobody can reach, discovered at a customer demo.

**Legitimate exemptions, and only these categories:**

| Category | Why no screen | Examples |
|---|---|---|
| Service-to-service | Never called by a browser | `svc-crypto` `/encrypt`, `/decrypt`, `/bidx`; `svc-authz` `POST /decide` |
| Operational | Consumed by compose, the deploy script and monitoring | every `GET /health` |
| Consumed, not displayed | The app reads it to render everything else | `svc-i18n` `GET /bundles/:locale` |

An exemption needs a one-line reason in the manifest. "Not needed yet" is not a reason — that is a
missing screen with better wording.

**This expands Phase 1.5.** The PWA shell now also carries the admin and compliance console that
covers the seven platform services' live endpoints, not only the ESS screens. That is the right
scope anyway: the statutory-rules governance screen and the audit-chain verifier are where the
compliance story becomes visible to a buyer, and they are the parts no competitor screenshot shows.

## 🔴 Open security gap — permissions are too coarse for row-level access

**Three instances found, same shape. Must close before Phase 2 puts real employee data behind them.**

The kernel's `PermissionGuard` answers "may this user perform this action", never "may this user
perform it on *this row*". `svc-authz` returns `scopeOrgUnitIds`, and **nothing consumes it**. So a
permission granted for a legitimate self-service purpose also unlocks every other row the same
route can reach.

| Route | Permission | The hole |
|---|---|---|
| `GET /documents/:id` | `document.read` | One permission covers contracts *and payslips*, with no ownership check. An employee who enumerates a document id reaches a colleague's payslip. |
| `GET /my/schedule` | `roster.read` | Same permission also covers team-wide roster routes. |
| Employee document/roster grants | both | Granted to `employee-ess` so self-service works, which is exactly what widens the exposure. |

Mitigated, not fixed: `document.read` is withheld from `hr-officer` and `hr-system-admin` so the
viewer cannot become a side door around Security doc §4.2's rule that HR roles never see payroll
amounts. That contains the blast radius while the tables are empty. It does nothing about
employee-to-employee exposure.

**The fix, and it is one fix for all three:**
1. Split permissions by scope — `*.read.self` for one's own rows, `*.read.scoped` for an org
   subtree, `*.read.any` for auditors. Keep payroll documents behind a payroll permission rather
   than a document one.
2. Make the guard *attach* `scopeOrgUnitIds` to the request, and give services a helper that
   applies it. The data is already returned and thrown away.
3. Every S3 read emits an audit entry with a purpose.
4. Regression test per route: employee A requesting employee B's row gets 403, not 200.

This is the fourth defect of this shape this phase — a component correct in isolation, asking the
authorisation question one level too coarsely. **Check every module controller in Phases 3–5 for
it as they are written**, rather than auditing afterwards.

---

## Superseded — `GET /documents/:id` has no ownership scoping

Found 2026-08-03 while fixing unreachable permissions. **Must be closed before Phase 2 puts real
employee data behind it.**

`svc-docs`'s `GET /documents/:id` is guarded by a single `document.read` permission that covers
every document kind — employment contracts, letters, and **payslips** — and the controller performs
no row-level ownership check. Anyone holding `document.read` can fetch any document by id,
including another employee's payslip. The kernel's `PermissionGuard` answers "may this user read
documents", never "may this user read *this* document"; `svc-authz` returns `scopeOrgUnitIds`, and
nothing consumes it here.

Mitigated for now, not fixed: `document.read` is deliberately withheld from `hr-officer` and
`hr-system-admin` so the viewer cannot become a side door around the Security doc §4.2 rule that HR
roles never see payroll amounts. That keeps the blast radius small while the schema is empty. It is
not a solution — `employee-ess` still holds the permission, and an employee guessing or enumerating
a document id reaches a colleague's payslip.

**The fix, owned by Phase 2:**
1. `docs.document` already carries `entity_type` and `entity_id`; the controller must compare them
   against the caller's identity and `scopeOrgUnitIds` before returning anything.
2. Split the permission by sensitivity — `document.read.self` for one's own contracts and payslips,
   `document.read.scoped` for HR within an org subtree, and keep payroll documents behind a payroll
   permission rather than a document one.
3. Every read emits an audit entry with a purpose, because a payslip is S3 data.
4. Regression test: employee A requesting employee B's document id gets 403, not 200.

This is the third defect of the same shape found this phase — a component correct in isolation, with
the authorisation question asked one level too coarsely. Worth checking for the same pattern in
every module controller Phase 2 adds.

## Parallel execution

Services are independent; the monorepo around them is not. Four agents in one tree collide on the
root `tsconfig.json` references array, `pnpm-lock.yaml`, `.tsbuildinfo` and the git index — not on
each other's code. So the shared surface is removed **before** fanning out: the controller
pre-scaffolds every service's `package.json`, `tsconfig.json`, root reference entry and
dependencies in one commit, then each agent owns exactly `services/<name>/{src,migrations}` and
touches nothing else. Agents run in isolated git worktrees so their commits cannot interleave.

---

## Contracts every phase depends on

These are fixed in Phase 1 and are the reason 15 services can be built by separate agents without colliding. Changing one is a cross-cutting change, not a local one.

### Event catalog — RabbitMQ topic exchange `gadong.events`

Routing key = event name. Payloads carry **no S3-class plaintext**; a consumer needing a sensitive field fetches it by ID through the owning service's audited API.

| Event | Producer | Payload |
|---|---|---|
| `employee.created` / `employee.updated` | onboarding | `{id, empCode, orgUnitId, employmentType, provinceCode, startDate, status, preferredLang}` |
| `employee.terminated` | onboarding | `{id, terminationDate, reasonCategory}` |
| `consent.granted` / `consent.withdrawn` | onboarding | `{employeeId, purpose, formVersion, at}` |
| `roster.published` | scheduler | `{rosterId, orgUnitId, dateRange, entryCount}` — summary only, deliberately |
| `roster.entry.published` | scheduler | `{rosterId, rosterEntryId, employeeId, workDate, scheduledStart, scheduledEnd, graceMin, hazardous, isHoliday}` — one per entry |
| `ot.approved` | scheduler | `{employeeId, otDate, hours, rateClass, approvedBy}` |
| `attendance.punch` | attendance | `{idemKey, employeeId, deviceId, punchedAt, direction, method, siteCode, matchScore, livenessPassed}` |
| `attendance.liveness_failed` | attendance | `{deviceId, at, siteCode}` |
| `timesheet.locked` | timesheet | `{periodId, dateRange, lockVersion, lockedBy}` — ⚠️ see the `ot_2x` contract below |
| `timesheet.corrected` | timesheet | `{dayRecordId, employeeId, workDate, correctedBy, reason}` |
| `leave.approved` / `leave.cancelled` | leave | `{requestId, employeeId, leaveTypeCode, dates, days, payMode}` |
| `leave.balance_payout` | leave | `{employeeId, leaveTypeCode, days, reason}` |
| `claim.approved_for_payroll` | claims | `{claimId, employeeId, amountThb, claimType}` |
| `claim.paid_offcycle` | claims | `{claimId, employeeId, paidAt}` |
| `payroll.committed` | payroll | `{runId, period, runType, employeeCount}` |
| `payslip.issued` | payroll | `{payslipId, runId, employeeId, lang}` |
| `rules.updated` | config | `{ruleKeys[], effectiveFrom}` |
| `audit.*` | every service | see audit entry shape below |

**Delivery contract:** producers write to their schema's `outbox` table in the same transaction as the state change; a relay in the kernel publishes. Consumers dedupe on `processed_events(event_id)`. Every consumer must be idempotent — duplicate delivery ×3 produces one effect (XC-EVENTS).

#### ⚠️ `timesheet.locked` and the `ot_2x` contract — read before touching OT

`timesheet.locked` carries no figures; M7 fetches the period's totals through M3's audited API once
a lock version is bound. **One of those totals does not mean what its name suggests, and two modules
have to agree about it or a payslip is quietly wrong.**

> **`day_record.ot_2x` is a PAY-RATE EQUIVALENT, not hours worked.** It is the number of hours
> payable at exactly 2× the hourly base, with LPA s.62's entitlement discount **already baked into
> the quantity**.

- A **monthly** employee is already paid a normal day's wage for a public holiday whether or not
  they work it, so the law owes only a further **+1×** for hours actually worked. M3 stores **half**
  the worked minutes, so that `half × 2× = 1×`.
- A **daily / hourly / contract** employee gets nothing for an unworked holiday, so the law owes the
  full **2×**, and M3 stores the **full** worked minutes.

An 8-hour holiday shift therefore writes `ot_2x = 4.00` for a monthly employee and `8.00` for a
daily-rate one. Nothing is lost — `day_record.worked_hours` always carries the true, unscaled hours.
**M7 applies `ot.holiday_work.multiplier` uniformly at 2× and must never re-derive the distinction
from pay basis.** Doing so pays a monthly employee half what s.62 owes, on a payslip that looks
entirely plausible.

**The trap, and why this is written here rather than in either module.** The Statutory Spec §4 used
to express the identical rule the *other* way round, with the discount in the **multiplier**
("+1× for employees entitled to paid holidays; 2× for daily-rate"). Both encodings are correct in
isolation. Applying **both** underpays by half; applying **neither** overpays by double. Each module
was internally consistent and separately tested, and **neither could detect the other's drift** —
M7's fixtures hard-coded `4` and `8`, M3's asserted `'4.00'`, and no test executed both.

**If a future rule pack moves the discount into the multiplier, M3's halving must be removed in the
same change.** `services/svc-payroll/src/engine/ot-2x-contract.cross-module.test.ts` runs M3's real
classifier into M7's real engine and fails if either side moves alone — verified by mutation in both
directions. §4 of the Statutory Spec has been corrected to match what shipped.

### Permission catalog — `resource.action`

Deny by default. Every route declares exactly one permission. Every grant carries an org scope (`self`, an org-unit subtree, or `*`).

```
employee.create  employee.read  employee.update  employee.lifecycle  employee.import
employee.sensitive.read
onboarding.manage  document.generate  consent.self
roster.read  roster.write  roster.publish  ot.request  ot.approve  holiday.manage
attendance.enrol.self  attendance.enrol.alternative  attendance.template.delete
attendance.punch.device  attendance.punch.verify  attendance.punch.code  attendance.punch.read
attendance.device.manage  attendance.security.read
timesheet.read  timesheet.correct  timesheet.lock  timesheet.unlock
leave.request  leave.approve  leave.admin  leave.balance.read
claim.submit  claim.approve  claim.approve.finance  claim.admin
payroll.profile.read  payroll.profile.write  payroll.run.prepare  payroll.run.calculate
payroll.run.approve  payroll.run.commit  payroll.export  payslip.read.self  payslip.read.any
config.rule.propose  config.rule.approve  config.pack.import  config.rule.read
audit.read  dpo.console  dsr.manage  retention.approve
biometric.template.read
authz.role.read  authz.role.grant  document.read
notify.notification.read  notify.notification.update
crypto.encrypt  crypto.decrypt  crypto.bidx
```

**`biometric.template.read` is granted to no human role, ever** — it exists only as a machine grant to `svc-attendance`. Security doc §4.2, asserted globally by XC-RBAC.

**Added 2026-08-14 (crypto-auth task) — `crypto.encrypt`/`crypto.decrypt`/`crypto.bidx`, machine-only, same absolute rule as `biometric.template.read` above.** `svc-crypto` used to accept `/encrypt`/`/decrypt`/`/bidx` with zero authentication — any container on the shared `gadong-internal` bridge network could reach it. These three now guard those routes (`services/svc-crypto/src/crypto.controller.ts`), granted per-service to exactly the subset each caller's own code path needs (never a coarse `crypto.access`) — see `deploy/scripts/seed.sh`'s grants table for the full per-service justification.

**Revised 2026-08-04 (integration reconciliation) — M4's attendance permissions replace four coarse
codes.** The catalog used to carry `punch.submit`, `enrolment.manage`, `device.register` and
`device.approve`, written before `svc-attendance` existed. M4 shipped nine finer-grained
`attendance.*` codes instead and never reconciled, so the four coarse codes were granted to roles
while being referenced by **no route in the codebase**, and all nine shipped codes were granted to
**no role** — every attendance route 403'd for every caller, `kiosk-device` included. A kiosk that
cannot punch is the whole module.

The shipped codes win, and the four coarse ones are retired rather than restored. They are what the
roadmap's own open security gap above asks for ("split permissions by scope"): `attendance.punch.*`
distinguishes a kiosk (device-authenticated) from a mobile 1:1 verify, a typed PIN and reading
one's own history — four genuinely different exposures that `punch.submit` collapsed into one
grant. The mapping is `punch.submit` → the four `attendance.punch.*`; `enrolment.manage` →
`attendance.enrol.self` / `attendance.enrol.alternative` / `attendance.template.delete`;
`device.register` + `device.approve` → `attendance.device.manage`.

⚠️ **One deliberate narrowing, recorded as a follow-up, not fixed here.** That last mapping is
two-into-one: this catalog split registering a device from approving it *specifically* so the two
could be held by different people. `attendance.device.manage` covers both. The two-person rule
still holds — `device.service.ts` rejects `registeredBy === approvedBy` with
`deviceApprovalRequiresSecondPerson()`, and a test pins it — but it is now enforced only by an
identity check at the service, not also by the permission split. Restoring the split is an
`svc-attendance` change (two decorators), out of scope for a manifest reconciliation. **Owned by
Phase 6 hardening, alongside the RBAC matrix generation.**

**Added 2026-08-03 (Task 14b, building `web/ui-coverage.json`):** the five codes on the last two
lines were already shipped in `@RequirePermission(...)` decorators but missing from this list.
`config.rule.read`/`authz.role.read`/`authz.role.grant` were already reconciled in
`services/svc-authz/src/seed/roles.ts`'s `PERMISSION_CATALOG`; `document.read` and both
`notify.notification.*` codes were not reconciled anywhere and are not granted to any of the ten
role templates in `seed/roles.ts` — those three routes are unreachable by any human role today.
Fixing the grants is `svc-authz`'s/`svc-notify`'s/`svc-docs`'s work, out of this task's scope.

**Segregation of duties, enforced in code and by DB constraint:**
- payroll run: `prepared_by ≠ approved_by`
- statutory config: `proposed_by ≠ approved_by`
- timesheet unlock: requires `timesheet.unlock` (Payroll Approver only) + reason, forces a variance report

### Role templates

`employee-ess` · `line-manager` · `hr-officer` · `payroll-officer` · `payroll-approver` · `hr-system-admin` · `compliance-approver` · `dpo` · `auditor-readonly` · `kiosk-device`

### Data classification → storage treatment

| Class | Examples | Treatment |
|---|---|---|
| **S3** | face template refs, national ID, bank account, salary, tax declarations, health attachments | envelope-encrypted `bytea` + blind index if searchable; **every read audited with a purpose** |
| **S2** | names, contacts, address, DOB, punch geo | envelope-encrypted `bytea`; normal RBAC |
| **S1** | rosters, shift definitions, leave types, org units | plaintext; TLS + volume encryption |
| **S0** | i18n bundles, holiday names | no special treatment |

Encrypted columns are `bytea`. AES-256-GCM, **AAD = `entity_id + ':' + field_name`** so ciphertext cannot be swapped between rows or fields.

**Ciphertext layout (revised 2026-08-02, Task 6 fix round 1):**

```
u8(version) ‖ u8(fieldClass) ‖ u16be(len(wrappedDEK)) ‖ wrappedDEK ‖ nonce(12) ‖ ct ‖ tag(16)
```

The 2-byte big-endian length prefix (added by the Task 3 review) exists because the original
`wrappedDEK ‖ nonce ‖ ct ‖ tag` has no delimiter — a reader cannot find where the wrapped key
ends, so **no consumer can validate anything beyond a total length**. Concretely, the Task 3
review verified that a 45-character plaintext address echoed back by a compromised or buggy
`svc-crypto` is accepted as valid ciphertext under a total-length check alone. The prefix makes
the envelope self-describing and lets both the kernel client and `svc-crypto` reject a
structurally impossible blob. The 1-byte `fieldClass` (2 = S2, 3 = S3) and 1-byte `version`
(currently always 1) were added by the Task 6 fix round 1 review: `decrypt`'s wire contract
carries no `fieldClass`, so without it in the envelope `svc-crypto` could only learn which KEK
(`kek-s2`/`kek-s3`) to unwrap under by trial-decrypting against every class in turn — which
collapses "Vault is sealed" (operational, self-healing) and "no KEK can unwrap this ciphertext"
(a data-integrity alarm) into one indistinguishable failure, and costs the hot S3 class an extra
Vault round trip on every decrypt. Reading `fieldClass` from the header lets `decrypt` unwrap
under exactly one KEK, always, and reject an unrecognised class or version outright rather than
guessing.

**Minimum valid length** = `1 + 1 + 2 + len(wrappedDEK) + 12 + 0 + 16`. With Vault Transit's
`aes256-gcm96` wrapped datakey (`"vault:v1:" + base64(version(1) ‖ nonce(12) ‖ ct(32) ‖ tag(16))`
= 93 ASCII bytes, pinned by `services/svc-crypto/src/vault.client.test.ts` rather than assumed)
this floor is **125 bytes**, pinned in `@gadong/kernel`'s `MIN_CIPHERTEXT_BYTES` (Task 6) and kept
in lock-step with `svc-crypto`'s own envelope format. The floor started at a provisional value of
28 (a true lower bound — a zero-length wrapped key and empty plaintext — but far too permissive to
catch an echoed plaintext), was raised to 123 when Task 6 fixed the wrap format, and to 125 when
the fix round 1 review added the version/fieldClass bytes.

⚠️ Kernel and `svc-crypto` must adopt the layout and the floor **together**. A mismatch means one
side writes envelopes the other rejects. Searchable S3 fields get a companion `<field>_bidx bytea` = `HMAC-SHA256(k_class, normalise(plaintext))`.

**Fail closed:** if Vault is sealed or unreachable, S2/S3 operations return 503. There is no plaintext fallback, ever.

**⚠️ Blind indexes are ASCII-only until further notice.** `normalise` is NFKC + trim + lowercase.
NFKC does **not** reorder Thai combining marks, because Thai vowel signs and tone marks carry
canonical combining class 0. So `สี่` typed as ส+ี+่ and as ส+่+ี normalise to *different*
strings and therefore to different HMACs — both orderings come off real Thai keyboards. A blind
index over Thai text would silently return nothing on a lookup, which for a uniqueness check
reads as "no duplicate found" rather than as an error.

This is **not** a live defect: the only blind-indexed fields in this design are `national_id`
(13 digits) and `email` (ASCII), neither of which can carry Thai marks. It is a standing
constraint on future work.

**Before adding a blind index over any field that can contain Thai script**, `normalise` must
first gain a canonical Thai mark-ordering step, and it must be added to `svc-crypto` and
`@gadong/kernel` in the same change — the two sides compute the same HMAC or lookups break
across services. Found in the Task 3 review, 2026-08-02.

### Audit entry

```
audit.entry(id bigserial, occurred_at, actor_id, actor_role, action, entity, entity_id,
            before_hash, after_hash, purpose, prev_entry_hash, entry_hash)
entry_hash = SHA256(prev_entry_hash ‖ canonical_json(entry_without_hash))
```

Append-only: the `audit` role holds INSERT and SELECT, never UPDATE or DELETE. Daily job anchors the chain head to a separate volume.

Every service emits `audit.*` for: writes to employee/time/pay/config data, **all S3 reads**, authz denials, logins, exports and downloads, consent changes, and key operations.

**⚠️ Audit payloads must carry hashes, not values (added 2026-08-02, Task 5 review).** The
`audit.entry` table stores `before_hash` / `after_hash`, never the values themselves. The Task 5
review found the emitter putting raw `before` / `after` objects into `outbox.payload` as plaintext
`jsonb` — so an S3 value (salary, national ID, bank account) sits in cleartext in the producing
service's outbox table until the relay reaps the row, and in the broker while in flight.

That defeats encrypt-before-write through a side door: the value is encrypted in its own column
and simultaneously present in plaintext one table over.

**Contract:** `AuditEmitter.emit` hashes `before` and `after` **before** they reach the outbox.
The audit event payload carries `before_hash` and `after_hash` only. A service that needs the
values for a diff view fetches them through the owning service's audited API, exactly as event
consumers do for any other S3 field. Owned by Task 9 (`svc-audit`), which must land the hashing in
the kernel emitter and the chain in the service together.

### Error envelope

```json
{ "code": "ONB-001", "message_i18n_key": "onboarding.error.invalid_national_id", "details": [] }
```

Prefixes: `ONB` `SCH` `TSH` `ATT` `LVE` `CLM` `PAY` `CFG` `AUZ` `CRY` `AUD` `I18` `DOC`.
Reserved across all services: `CRY-503` crypto unavailable — write refused (fail closed) · `AUZ-403` permission denied · `AUZ-409` segregation-of-duties violation.

### Database conventions

- UUIDv7 primary keys · `created_at` / `updated_at timestamptz` · hard delete per the PDPA schedule, `deleted_at` only where retention requires it.
- Every schema has `outbox(id, topic, payload, created_at, published_at)` and `processed_events(event_id PK, processed_at)`.
- `employee_id` is replicated into per-schema `*_employee_ref` read models via `employee.*` events. **No foreign keys across schemas. No cross-schema queries.** Each service's DB role is granted only its own schema.
- Migrations run per service with `node-pg-migrate` on startup.

### Internationalisation

- All user-visible strings via i18n keys namespaced per module (`leave.request.submit`). Missing key → English fallback + logged warning. Zero missing keys is a release gate.
- Dates stored ISO-8601 Gregorian UTC, always. Thai locale renders Buddhist Era (พ.ศ. = C.E. + 543); Thai date inputs accept both (year > 2400 ⇒ B.E.). **Never store B.E.**
- Money: THB, satang precision in engines, rounding only at render.
- PDFs embed Sarabun (Thai), Noto Sans SC (Simplified Chinese), Noto Sans (Latin).

### Statutory values are data, never code

Every Thai statutory figure resolves through `svc-config` by rule key and date. No module may hard-code a rate, threshold, multiplier or bracket. The acceptance test is PRD M7-2's: a September 2026 payroll run applies no EWF and an October 2026 run applies 0.25%, with no code change.

---

## Standing constraints

- **Build only in CI**, pull from `ghcr.io/mavrone81/gadonghr-<service>`. Never `docker compose build` on the server.
- SHA-tagged images need the scoped keep-4 prune cron — plain `docker system prune` cannot see tagged images.
- Never `docker compose down -v`. Losing `vault_data` is permanent loss of every encrypted field.
- Node 22 · TypeScript strict · pnpm workspaces · Jest · conventional commits.
- Coverage gates: ≥85% lines on engine packages; **100% branch on `GrossToNetEngine` and `OtClassifier`**.
- Secrets never committed; `.env` is server-side only, chmod 600.

## 🔴 STATUTORY FIGURES THAT ARE NOT YET VERIFIED — for Legal counsel and the Finance lead

**Raised 2026-08-04 by the M7 payroll build and recorded here, not in a build report, because these
are decisions for people who do not read build reports.** Every item below is a number the payroll
engine will use to pay real people and file real returns. None of them is a coding task. Each says
what happens *if it is wrong*, because "unverified" understates it — an unverified figure does not
produce an error, it produces a confident, plausible, wrong payslip.

Everything here resolves through `svc-config` as effective-dated data, so **each fix is a rule-pack
import, not a code change or a release.** The engineering is done; the figures are not.

### Go-live blockers — payroll cannot be trusted in production until these are answered

| # | Figure | Why it blocks | Consequence if wrong |
|---|---|---|---|
| **V4** | **The 2026 provincial minimum-wage table — all 77 provinces.** Not shipped. Two provinces are seeded as placeholders (Bangkok 400, one low band 337), both citing "Spec §12 V4 — verify". | Every employee's base pay is checked against their own province's floor. 75 provinces have no figure at all. | **Underpaying below the statutory floor**, per employee, every month, plus back-pay and penalties. |
| **N1** | **The EWF wage base: capped at the SSO ceiling, or uncapped?** The Statutory Spec never states it. The engine supports both (`sso_capped_wage` / `sso_wage`) and the rule pack must choose. | EWF contributions start **1 October 2026**. There is no default that is safe to guess. | Capped vs uncapped is a **≈2.6× difference** in the contribution for higher earners — wrong for both the employee deduction and the employer cost, from the first October payslip. |

**V4 now fails closed (changed 2026-08-04).** An employee whose province has no notification on file
used to produce a *payslip note* and the run continued — so an unverified wage was paid on a payslip
indistinguishable from a checked one, and the note was the only difference. The engine and the
profile-write path now both reject with **PAY-012**. This will genuinely block payroll runs outside
the two seeded provinces, which is the intended behaviour of a blocker: the alternative is paying
unverified wages that look verified. Pinned by
`services/svc-payroll/src/engine/gross-to-net.test.ts`.

### Must be confirmed before the first live run of the affected feature

| # | Figure | What is unverified | Consequence if wrong |
|---|---|---|---|
| **N9** | **All four bank file layouts** — KBank, SCB, BBL, Krungsri. Field widths, header/trailer codes and encoding were written from convention, **not from any bank's published specification**; `bank-files.ts` says so at the top. | No layout has been validated against a real bank test file. | **The salary payment file is rejected, or worse, accepted and misapplied.** Nobody gets paid on payday. Needs one test file per bank, from each bank. |
| **N3–N5** | **Taxability and SSO treatment of severance, accrued-leave payout, and notice-in-lieu.** Three separate questions: whether each is PIT-taxable, and whether each enters the SSO contribution base. | Termination pay is the highest-value, lowest-frequency calculation in the product — errors are large and are noticed by the leaver. | Over- or under-withholding on a final payment, and an incorrect SSO filing for the month. |
| **N6–N8** | **Three monthly→daily divisors**, deliberately kept as separate rule keys: `ot.hourly_base.days_divisor` (OT), `minwage.monthly_equivalent_divisor` (the minimum-wage test), `severance.daily_wage_divisor` (s.118 tiers). 30 is assumed for each. | They are separate keys precisely so a company changing its OT convention (e.g. to 26 days) cannot silently move the statutory minimum-wage test or the severance base. Which divisor is *legally* correct for each purpose is unconfirmed. | 30 vs 26 is a **~15% swing** in the hourly base, the daily-equivalent floor comparison, and every severance tier. |

**Owner: Legal counsel** for V4, N1, N3–N5, N6–N8. **Owner: Finance lead** for N9 (obtaining each
bank's specification and a test file). **None of these can be closed by Engineering.**

## Open items that block later phases

| Item | Blocks | Owner |
|---|---|---|
| PRD Q2 — CompreFace FAR/FRR benchmark on Thai/Chinese faces, CPU latency < 2 s | Phase 3 exit | Engineering |
| Statutory §12 V2 — exact gazetted 2026 SSO ceiling (17,500 assumed) | Phase 5 config freeze | Legal |
| Statutory §12 V1 — LPA No. 9 maternity pay split (employer vs SSO days) | Phase 4 | Legal |
| **Statutory §12 V4 — 2026 provincial minimum-wage table (75 of 77 provinces missing; now fails closed with PAY-012)** | **Phase 5 GO-LIVE** | Legal |
| **Statutory N1 — EWF wage base, capped vs uncapped (≈2.6× difference, live 1 Oct 2026)** | **Phase 5 GO-LIVE** | Legal |
| Statutory N9 — four bank file layouts unverified against any bank's spec | Phase 5 first live payment | Finance |
| Statutory N3–N5 — taxability/SSO base of severance, leave payout, notice-in-lieu | Phase 5 first termination | Legal |
| Statutory N6–N8 — three monthly→daily divisors (30 assumed; ~15% swing) | Phase 5 config freeze | Legal |
| UI direction selection | Phase 2 web shell | Product |
| **4 GB RAM ceiling** — Phase 1 fits; Phase 3 adds CompreFace (2–3 GB) | Phase 3 | Product |
