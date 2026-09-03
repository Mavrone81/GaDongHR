# Phase 6 — Hardening Implementation Plan

**Written 2026-08-26**, against the code that exists at `91622af` — Phases 1–5 all merged and
deployed, `hr.bevorasg.com` live on `157.230.38.96` serving fifteen services plus `web`.

**Goal:** close Security doc §8 — the checklist that gates GA. Phases 1–5 built the product and
proved it works. Phase 6 proves it holds under an attacker, under load, and under a disaster, and
proves the PDPA promises the compliance doc makes are mechanically true rather than intended.

**This phase is different from 1–5 in one important way:** most of its tasks find nothing to build.
A restore drill that passes produces no commit. That is the point — the deliverable is evidence,
committed as signed-off records under `deploy/signoff/` and `docs/06-testing/`, not features.
Tasks that *do* produce code are marked ⚙.

---

## Global Constraints

Phase 1's Global Constraints remain binding in full. These are additional and specific to Phase 6.

- **No hardening task may be marked done on the strength of a test that runs only in CI.** Every
  claim in the Exit Criteria is verified against `gadonghr-prod` or against a throwaway restored
  from `gadonghr-prod`'s own backups. CI proves the code; this phase proves the deployment.
- **Nothing in this phase runs against production data without a written purpose.** The pen test
  gets a seeded fixture tenant, not the pilot customer's employees. Any S3 read this phase causes
  is audited like any other and carries a `purpose` naming this plan.
- **Evidence is committed; secrets never are.** Findings, drill logs, k6 output and the RBAC matrix
  land in the repo. Shares, tokens, `age` identities, PGP private material and pen-test credentials
  do not — `deploy/signoff/key-register.md`'s standing prohibition covers this whole phase.
- **A failed drill is a finding, not a retry.** If the first restore attempt fails, the failure and
  its cause get recorded before the fix. An unbroken record of green drills that quietly omits the
  three that failed is worse than no record.
- **Severity language is fixed:** Critical = exploitable now against production, Blocker for GA;
  High = exploitable with a precondition; Medium = defence-in-depth gap; Low = hygiene. Only
  Critical and High block the Exit Criteria.

---

## State at entry — what is already true, and what is not

Verified 2026-08-26 against the live host and the tree at `91622af`.

**Holds already:**
- All routed services report `91622af` and `status: ok` (`svc-config`, `svc-authz`, `svc-audit`,
  `svc-docs`, `svc-i18n`). `svc-crypto` is correctly not publicly routed.
- `restore-verify.sh` exists and structurally isolates every throwaway resource from the production
  compose project.
- 58 source files carry `@RequirePermission`; `PERMISSION_CATALOG` in
  `services/svc-authz/src/seed/roles.ts` is the single catalog.
- Deploy is gated on `refs/ci-pass/<sha>`, itself gated on the real-stack e2e and real-broker suites.

**Does not hold, and Phase 6 owns each:**
1. **The Vault key ceremony has never been performed.** All five officer rows in
   `deploy/signoff/key-register.md` are blank. Production is running on a Vault that was never
   rekeyed to 5-of-3.
2. **Consequently `VAULT_TOKEN` is unprovisioned on `gadonghr-prod`, so `backup.sh` skips the raft
   snapshot.** Its own header states the consequence plainly: such an archive *cannot restore any
   encrypted field*. Every backup taken to date is incomplete. This is the single highest-severity
   item in the phase and Task 1 exists to clear it before anything else.
3. **`svc-notify` is `degraded` in production — `smtp: down`.** No notification mail is being
   delivered. Every SLA the compliance doc measures in notified-days is currently unmeasurable.
4. **Production deploys off a `GADONG_DEPLOY_BRANCH` override**, while the script's default is
   `main`. Resetting that variable would deploy a kernel-only commit over a working system.
5. **`attendance.device.manage` collapses register and approve** into one permission — the
   deliberate narrowing recorded in the roadmap and explicitly assigned to this phase.
6. **`document.read` and both `notify.notification.*` codes are granted to no role template**, so
   those routes are unreachable by any human.
7. No RBAC matrix, no k6 run, no liveness bypass suite, no PDPA deletion verification, no external
   pen test.

---

## Task 1: The Vault key ceremony — and a backup that can actually restore

Everything else in this phase is lower severity than this. Until it is done, a disk failure on
`gadonghr-prod` is unrecoverable loss of every encrypted field.

- [ ] Choose five officers per `key-register.md`'s Composition guidance — accountable and available,
      not convenient. Not five people from one team; include the DPO.
- [ ] Collect a PGP public key per officer *before* the ceremony. Verify each fingerprint out of band.
- [ ] Run `deploy/scripts/vault-ceremony.sh` on `gadonghr-prod`. **Read the consequence paragraph
      out loud, in the room, before the first share is generated.** That instruction is in the
      register for a reason; it is not ceremony for its own sake.
- [ ] 5 shares, threshold 3. Each share encrypted to exactly one officer's key. No share ever
      transits a chat client, a ticket, or this repository.
- [ ] Fill in and sign every row of `deploy/signoff/key-register.md` **during** the ceremony —
      never from memory afterwards.
- [ ] Run `deploy/scripts/vault-verify-ceremony.sh`. Confirm 5/3 and that the old root token is revoked.
- [ ] Provision the `VAULT_TOKEN` that can read `sys/storage/raft/snapshot`, scoped to exactly that.
      Write it server-side, `chmod 600`, never into the repo.
- [ ] Run `backup.sh` and assert the archive now contains a real `vault.snap` — the previous
      `WARNING: VAULT_TOKEN is not set` line must be gone.
- [ ] Commit — `docs(signoff): record the Vault key ceremony` (register only; no key material).

---

## Task 2: The restore drill — prove the backups, with the snapshot in them

Runbook §3's quarterly drill, run for real for the first time against an archive that contains a
Vault snapshot.

- [ ] Take a fresh `backup.sh` archive post-Task 1.
- [ ] `restore-verify.sh <archive> --age-key-file <identity> --vault-unseal-key ...` with **three
      real officer shares**, physically present. This is the leg that has never run: the script's
      staging-Vault path proves the mechanism, but only real shares prove *these* officers can
      unseal *this* snapshot.
- [ ] Assert all three legs: Postgres row counts match `manifest.json` exactly; the real `vault.snap`
      restores and unseals; MinIO objects enumerate.
- [ ] **Then the leg that matters most:** decrypt one employee's national ID *from the restored
      stack*. A restore that reproduces rows but cannot decrypt them is not a restore.
- [ ] Time the whole drill wall-clock and record it against the Runbook's RTO.
- [ ] Record the run — date, operator, officers present, archive id, result, duration — in
      `deploy/signoff/restore-drills.md` (new file). ⚙
- [ ] Commit — `docs(signoff): first verified restore drill`

---

## Task 3: Fix the two live operational defects

Small, and they block honest measurement of everything downstream.

- [ ] **SMTP.** Diagnose `svc-notify`'s `smtp: down` on prod — credentials, egress from the droplet,
      or `SMTP_FROM=no-reply@bevorasg.com` failing SPF/DKIM at the receiving end. Fix, then assert
      `/api/notify/health` returns `ok` and a real message arrives.
- [ ] Add a delivery assertion to the health check so a silent SMTP failure surfaces as `degraded`
      rather than being noticed by a human two weeks later. ⚙
- [ ] **Deploy branch.** Once `main` carries `91622af`, set `GADONG_DEPLOY_BRANCH=main` on the host
      and delete the override, so the script's default and the host's behaviour agree.
- [ ] Prove the loop still closes: push a trivial change, watch `=== Deploy OK: <sha> ===`, confirm
      the health endpoint reports the new sha.
- [ ] Commit — `fix(svc-notify): restore mail delivery and fail loudly when it stops`

---

## Task 4 ⚙: RBAC matrix generation

Security doc §8's "every role × representative endpoint — generated from the permission catalog".
Generated, not hand-written: a hand-written matrix goes stale the first time someone adds a route.

- [ ] Build `tools/rbac-matrix/` — walks every `@RequirePermission()` in `services/*/src`, crosses it
      with the ten role templates in `seed/roles.ts`, emits `docs/06-testing/RBAC-MATRIX.md`.
- [ ] Emit a companion executable suite: one test per (role, route) cell, asserting allow or 403
      against the real stack. The matrix document and the suite come from one source.
- [ ] Assert the invariants the phase cares about, as failing-by-default tests:
      - Every route declares exactly one permission. A route without one fails.
      - `biometric.template.read` is held by no human role.
      - No role holds both sides of any SoD pair (`prepared_by`/`approved_by`,
        `proposed_by`/`approved_by`).
      - Every catalog permission is reachable by at least one role — this is what would have caught
        `document.read` and `notify.notification.*` being orphaned.
- [ ] Wire into CI so the matrix regenerates and the suite runs on every push.
- [ ] Commit — `feat(tools): generate the RBAC matrix from the permission catalog`

---

## Task 5 ⚙: Close the two permission gaps the matrix will surface

- [ ] **Split `attendance.device.manage`** back into `attendance.device.register` and
      `attendance.device.approve` — two decorators in `svc-attendance`, plus catalog and role-template
      updates. The two-person rule currently rests only on `device.service.ts`'s
      `registeredBy !== approvedBy` identity check; this restores the permission-level enforcement the
      catalog was designed around, so that a single compromised account cannot do both even if that
      check is bypassed.
- [ ] Keep the existing identity check. Defence in depth means both, not either.
- [ ] **Grant `document.read` and `notify.notification.*`** to the role templates that should hold
      them, or delete the routes. An unreachable route is either a missing grant or dead code; decide
      which, per code, and record the decision.
- [ ] Re-run the Task 4 matrix; the "every permission reachable" invariant must now pass.
- [ ] Commit — `fix(svc-attendance): re-split device register from device approve`

---

## Task 6 ⚙: PDPA deletion verification

The compliance doc's central promise. `retention-job` implements crypto-erasure; this proves it.

- [ ] End-to-end test on the real stack: onboard a fixture employee with biometric consent → enrol →
      withdraw consent → run `retention-job` → assert **all** of:
      - the DEK is destroyed and the ciphertext is now undecryptable (not merely a row flagged deleted);
      - the CompreFace template is gone, verified by querying CompreFace directly — §7's
        "deletion verification against CompreFace", not an assumption that our delete call worked;
      - the audit chain contains the withdrawal, the erasure, and the actor for each;
      - the erasure happened inside the withdrawal SLA the compliance doc states.
- [ ] The refusal path: an employee who declines biometrics onboards fully via the alternative
      credential, and no template is ever created.
- [ ] Assert the DPO queue surfaces each erasure for sign-off rather than erasing silently.
- [ ] Commit — `test(pdpa): prove crypto-erasure destroys the key, the template, and nothing else`

---

## Task 7 ⚙: Liveness bypass attempt suite

§8's "liveness bypass attempt suite", against the M4 kiosk path.

- [ ] Assemble the attack set against the **consented synthetic** face dataset only — never a real
      employee's face (TEST-STRATEGY §2, and it would itself be a PDPA violation): printed photo,
      phone-screen replay, video replay, mask proxy, and the same face at deliberately degraded
      match scores.
- [ ] Assert each is rejected, and that each rejection raises a security event carrying the device id.
- [ ] Assert the device path independently: an unregistered device is refused even with a genuine
      face; a registered-but-unapproved device is refused; a stolen device secret without device
      approval is refused.
- [ ] Record the match-score threshold this suite pins, so a later tuning change cannot silently
      lower it — a threshold change that passes no test is how buddy-punching returns.
- [ ] Commit — `test(svc-attendance): liveness and device-spoofing bypass suite`

---

## Task 8 ⚙: k6 load, against PRD §7.5's four numbers

Exact targets, from TEST-STRATEGY §1. No target is "roughly".

- [ ] `test/load/` k6 scenarios:
      - **Punch burst 10/s** sustained across a shift-start window. Assert zero punch loss —
        the outbox makes this checkable rather than assumed.
      - **Payroll: 1,000 employees in under 10 minutes**, gross-to-net through committed run.
      - **API p95 < 500 ms** across the representative route set.
      - **Face match ≤ 2 s** end to end at the kiosk.
- [ ] Run against a production-shaped host. The prod box is 2 vCPU / 4 GB — if a target is missed
      there, the finding is *"the sizing is wrong"*, recorded as such, not quietly re-run on a bigger box.
- [ ] Include one broker-restart-under-load run: restart RabbitMQ mid-burst, assert still zero loss.
      Phase 3 proved this at rest; this proves it under pressure.
- [ ] Record results in `docs/06-testing/LOAD-TEST-RESULTS.md` with host spec and date.
- [ ] Commit — `test(load): k6 scenarios for the four PRD §7.5 targets`

---

## Task 9 ⚙: Application security baseline (Security doc §6)

Sweep the ASVS L2 baseline and fix what is not already true. Do this *before* the external pen test —
paying an external team to find a missing security header is a waste of the engagement.

- [ ] Rate limiting at Traefik; brute-force lockout in Keycloak; session ≤ 12 h with refresh rotation.
- [ ] Step-up re-auth actually enforced on payroll approve, exports, and consent withdrawal.
- [ ] Security headers, CSRF token + SameSite, output encoding, schema validation on every input.
- [ ] File uploads: type/size validation and **ClamAV scan before storage**; content-disposition set;
      no inline execution.
- [ ] Containers: non-root, read-only rootfs where possible, `no-new-privileges`, pinned digests.
- [ ] **trivy in CI** for dependencies and images; fail the build on Critical/High with a documented,
      dated, owner-named exception path for anything accepted.
- [ ] Commit — `fix(security): close the ASVS L2 baseline gaps`

---

## Task 10: External penetration test — web, API, and kiosk

- [ ] Scope explicitly to all three surfaces. The kiosk is the one most often dropped from an
      engagement and is the one with a physical attacker in its threat model.
- [ ] Provide a seeded fixture tenant, one account per role template, and the RBAC matrix from Task 4
      — a tester who knows the intended model finds authorisation bugs that black-box testing misses.
- [ ] Require the STRIDE table (§7) be exercised explicitly, not just OWASP Top 10: buddy-punching,
      fake kiosk, timesheet tampering for pay, insider salary browsing, punch-storm DoS, token replay.
- [ ] Triage every finding to the fixed severity scale. Fix Critical and High; record Medium and Low
      with an owner and a date.
- [ ] Retest the Critical and High fixes. An unretested fix is a claim.
- [ ] Record scope, dates, firm, findings and remediation in `docs/06-testing/PENTEST-REPORT.md`
      (findings and status; no live exploit detail for anything still unfixed).
- [ ] Commit — `docs(testing): external penetration test findings and remediation`

---

## Task 11: Encryption design review

§8 lists this separately from the pen test, and it is separate work: a design review reads the scheme,
it does not probe the endpoint.

- [ ] External reviewer walks the envelope scheme: AES-256-GCM, `wrappedDEK ‖ nonce ‖ ct ‖ tag`,
      **AAD = `entity_id + ':' + field_name`**, Vault Transit wrapping, per-class blind-index keys.
- [ ] Specific questions to put in writing, because each is a way the scheme fails quietly:
      nonce generation and reuse risk; DEK lifetime and rotation; blind-index correlation leakage
      across fields sharing a class key; whether AAD binding genuinely prevents cross-entity
      ciphertext transplant; key rotation without re-encrypting every row.
- [ ] Confirm the fail-closed path is a *design* property, not a code accident: sealed Vault ⇒ 503
      `CRY-503`, never a plaintext write.
- [ ] Record the review and its outcomes in `docs/04-architecture/ENCRYPTION-REVIEW.md`.
- [ ] Commit — `docs(architecture): external encryption design review`

---

## Exit criteria

Phase 6 is done — and Security doc §8 is complete — when all of these hold on the live host:

1. `key-register.md` has five named, signed officers; Vault is 5-of-3; the root token is revoked.
2. A backup archive contains a real `vault.snap`, and `restore-verify.sh` passes all three legs
   against it using three real officer shares.
3. **An employee's national ID decrypts correctly from a stack restored entirely from backups.**
4. `/api/notify/health` reports `ok`, and a broken SMTP path makes it report `degraded` within one
   health interval.
5. `GADONG_DEPLOY_BRANCH` is `main` on the host, matching the script default; the push→deploy loop
   is proven green after the change.
6. `docs/06-testing/RBAC-MATRIX.md` is generated in CI, and its suite passes: one permission per
   route, `biometric.template.read` held by no human role, no role holding both sides of an SoD
   pair, every catalog permission reachable.
7. Registering a device and approving it require two different permissions **and** two different people.
8. Consent withdrawal destroys the DEK, the ciphertext is undecryptable, CompreFace confirms the
   template is gone, and the audit chain proves all three happened within SLA.
9. Every liveness bypass attempt in the suite is rejected and raises a security event.
10. All four PRD §7.5 targets are met on production-shaped hardware, with zero punch loss across a
    broker restart under load.
11. trivy gates CI on Critical/High, and every accepted exception has an owner and a date.
12. The external pen test's Critical and High findings are fixed **and retested**; Medium and Low
    are recorded with owners.
13. The encryption design review is complete and its findings are closed or accepted in writing.

Only when 1–13 hold is the product GA-ready. Item 3 is the one to be least willing to hand-wave: it
is the difference between having backups and having recoverable backups, and it is currently false.
