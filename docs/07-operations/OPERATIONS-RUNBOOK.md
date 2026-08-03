# GaDongHR — Operations Runbook

| Field | Value |
|---|---|
| Version | 0.1 (Draft) · Date 2026-08-02 · Stage 5 |
| Audience | Customer IT admin / vendor support |
| Related | `../../deploy/docker-compose.yml`, Security doc §3.3, PDPA doc §5 |

## 1. Fresh Install (target < 60 min — PRD Goal 3)

Prereqs: Ubuntu 22.04+/Debian 12 host, 8 vCPU / 16 GB RAM / 200 GB SSD, Docker Engine 27+ with Compose v2, DNS A-record for `PUBLIC_HOST`, ports 80/443 open. Recommended: LUKS full-disk encryption on the host.

```bash
git clone https://github.com/Mavrone81/GaDongHR && cd GaDongHR/deploy
cp .env.example .env            # fill every CHANGE_ME (openssl rand -base64 32)
docker compose --profile core pull
docker compose --profile core up -d postgres vault
./scripts/vault-init.sh         # ← ceremony below, ONCE
docker compose --profile core up -d
./scripts/seed.sh               # statutory packs, holidays, provinces, roles, i18n
./scripts/bootstrap-admin.sh    # first HR/System Admin + forces MFA setup
```

Verify: `docker compose ps` all healthy; login at `https://PUBLIC_HOST`; Setup Wizard completes (company profile, DPO details, provident-fund flag → EWF behaviour, holiday confirmation).

## 2. Vault Key Ceremony (CRITICAL — do once, do it right)

**Current state on `gadonghr-prod` (as of this writing): Vault was
initialised with ONE Shamir share, threshold ONE, plus the initial root
token, both sitting in `deploy/.env` under a "STAGING ONLY — NOT FOR REAL
EMPLOYEE DATA" block. This is a bring-up convenience, not a production
configuration, and it MUST be closed by the procedure below before any
real employee data enters the system.** Vault is already initialised —
this procedure is a **rekey**, not an init: `vault operator init` is not
run again.

### Why `-pgp-keys`, not a plain rekey

`vault operator rekey` on its own PRINTS every new share to whoever runs
it — the operator sees all five, which defeats the split entirely. The
correct mechanism is `vault operator rekey -pgp-keys=<5 officer public
keys>`: Vault encrypts each new share to a different officer's PGP public
key before returning it, so the operator (human or script) only ever
sees ciphertext. `deploy/scripts/vault-ceremony.sh` always uses this
mechanism and refuses to run any other way.

### Before the ceremony — what each of the 5 officers must supply

Each officer generates their own PGP keypair in advance (their own
machine, never generated for them by the operator) and exports the
**public** half only:

```bash
gpg --armor --export <officer-email> > <officer-slug>.asc
```

The operator collects all 5 `.asc` files into `deploy/signoff/pgp-keys/`
on the deploy host (gitignored — never committed, see `deploy/.gitignore`),
named `<officer-slug>.asc`. `vault-ceremony.sh` refuses to run unless
**exactly 5** files are present and none of them looks like a private
key.

### Running the ceremony

All 5 officers present (in person or on a call, per your organisation's
policy — not delegated to one person "on behalf of" the others):

```bash
cd deploy && set -a && source .env && set +a
./scripts/vault-ceremony.sh --confirm-five-officers-present
```

`vault-ceremony.sh`:
1. Refuses to run without the confirmation flag, without Vault reachable
   and unsealed, without exactly 5 PGP public keys present, or without
   the current unseal key available to authorise the rekey.
2. Refuses to run again against a Vault already rekeyed to 5 shares,
   unless `--force` is passed (only for a deliberate re-rekey, e.g.
   replacing an officer — see `signoff/key-register.md` rule 5).
3. Runs `vault operator rekey -init -key-shares=5 -key-threshold=3
   -pgp-keys=... -backup` — the `-backup` flag keeps a Vault-side copy
   recoverable **only for the ceremony window**, not indefinitely (see
   below).
4. Submits the CURRENT unseal key to authorise the operation, over
   stdin only — never as a command argument, never logged.
5. Verifies Vault's response is genuinely PGP-encrypted (5 fingerprints,
   ciphertext-shaped payloads) before writing anything. **If Vault ever
   returns anything that doesn't look encrypted, the script aborts and
   says so — it does not write a plaintext share, ever, under any
   condition.**
6. Writes each officer's encrypted share to its own file, mode 400,
   under `deploy/signoff/shares/` (also gitignored).
7. Removes `VAULT_UNSEAL_KEY` and `VAULT_ROOT_TOKEN` — and the "STAGING
   ONLY" warning block around them — from `deploy/.env`.
8. Prints the exact remaining manual steps (below).

### Rules

1. Each share goes to a **different named key officer**, hand-delivered
   or over a channel already trusted with this class of secret — **never
   stored on the host, never in chat/email, even encrypted.**
2. Record officers in `deploy/signoff/key-register.md` — name, role,
   contact, PGP fingerprint, share file, date issued, signature.
3. **Loss of 3+ of the 5 shares is permanent, irreversible loss of every
   encrypted field in the system** — national IDs, bank accounts,
   salaries, health attachments, face-template references, all of it,
   forever. **There is no vendor backdoor.** This is the design, not an
   oversight. Say it out loud in the ceremony room before the first
   share is generated.
4. After host reboot Vault starts **sealed**: 3 officers run
   `docker compose exec vault vault operator unseal` (once each). Until
   unsealed, sensitive-field operations return 503 by design (fail
   closed).
5. No officer ever holds two shares. A vacant seat is filled by
   re-rekeying with a replacement officer (`--force`), never by doubling
   up.
6. Rotate the AppRole secret quarterly (`scripts/rotate-approle.sh`);
   rotate KEK versions yearly (`scripts/rotate-keks.sh` — re-wraps, no
   downtime). Both remain out of scope for this task — see
   `deploy/README.md`.

### After the ceremony — verification

Each officer independently confirms they can decrypt their own share:

```bash
base64 -d <officer-slug>.share.b64 | gpg --decrypt
```

and signs `deploy/signoff/key-register.md`. Then run the read-only proof
step — this is what shows the ceremony actually happened, rather than
the team believing it did:

```bash
./scripts/vault-verify-ceremony.sh
```

It reports `Total Shares` / `Threshold` from `vault status`, confirms
`deploy/.env` no longer holds either staging key, and best-effort
confirms the `-backup` copy is gone (see below for why that one can't
always be proven with certainty).

### The `-backup` copy — destroy it, and not before

`-backup` exists so a share lost or corrupted **during the ceremony
itself** (a bad hand-off, a decryption failure) can be recovered without
re-rekeying from scratch. It is not a standing safety net and must not
outlive the ceremony:

- **Destroy it only once every one of the 5 officers has confirmed
  successful decryption above** — destroying it earlier removes the
  ceremony's own recovery path before it's needed; leaving it after
  defeats the purpose of the split (a copy of every new share, still
  sitting on the one Vault instance).
- Once all 5 have confirmed:
  ```bash
  docker compose exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" vault vault operator rekey -backup-delete
  ```

### The root token

`vault-ceremony.sh` does not run this for you — it is correctly gated on
every officer's confirmation above, which cannot happen inside one
non-interactive script run. After the `-backup-delete` step:

```bash
docker compose exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" vault vault token revoke -self
```

There is deliberately **no standing replacement token or AppRole for
interactive admin access** after this. `svc-crypto`'s own ongoing access
is unaffected (a separate AppRole, unrelated to the root token). Any
future admin operation that genuinely needs root-equivalent Vault access
(policy changes, mounting a secrets engine) goes through
`vault operator generate-root`, which itself requires a fresh quorum of 3
of the 5 officers — the same trust model as unsealing, deliberately,
rather than a long-lived credential sitting in `.env` again. **If a
standing, lower-privilege admin credential (a named policy plus an
AppRole or OIDC login) is later wanted for convenience, that is a
separate, explicitly scoped follow-up task** — trading the current
"no standing credential" posture for a "standing but least-privilege
credential" one is a real decision with real trade-offs, not a default.

## 3. Backup & Restore (RPO ≤ 24 h, RTO ≤ 4 h)

Nightly cron (`scripts/backup.sh`):
1. `pg_dump -Fc` all schemas → 2. MinIO mirror (`mc mirror`) → 3. `vault operator raft snapshot save` → 4. tar + encrypt with **offline backup key** (age) → 5. ship off-host (rsync/S3-compatible), keep 30 daily + 12 monthly.

Restore drill (**mandatory quarterly, and in UAT U1**): fresh host → install steps 1–4 → restore Vault snapshot → unseal (3 officers) → `pg_restore` → MinIO restore → start stack → run `scripts/verify-restore.sh` (decrypts a sentinel record, checks audit chain head, recomputes one golden payslip). A backup that hasn't been restore-tested is not a backup.

## 4. Monitoring & Alerts (observability profile)

Golden signals per service (Prometheus): p95 latency, error rate, queue depth (RabbitMQ), outbox lag, punch-ingest rate, face-match latency, Vault seal status, disk %, cert expiry. Grafana dashboards shipped in `observability/`. Page-level alerts: Vault sealed >5 min · outbox lag >100 · punch pipeline stalled >10 min during working hours · backup job failed · disk >85% · audit chain verification failure (daily job).

## 5. Routine Operations

| Task | Cadence | How |
|---|---|---|
| Rule-pack updates (tax/SSO/wage changes) | On Royal Gazette changes; vendor-signed packs | Import in Admin → Statutory Rules → requires second-person approval; pre-loaded future rules (e.g. EWF) alert 60/30 days before effective |
| Minimum-wage table refresh | Per Wage Committee notification | Same signed-pack flow |
| Retention job review | Weekly | DPO queue (PDPA doc §7) — approve crypto-erasure batch |
| Liveness-fail review | Weekly | Attendance security events (PRD metric) |
| Restore drill | Quarterly | §3 |
| Access review | Quarterly | Export role grants; managers confirm team scopes |
| Upgrade GaDongHR | Per release | `git pull && docker compose pull && docker compose up -d` — migrations run automatically; **always backup first**; read release notes for rule-pack prerequisites |

## 6. Incident Playbooks (extracts)

- **Suspected data breach**: isolate (block gateway), preserve logs/volumes, open breach register in DPO console, assess scope via audit trail, PDPC notification ≤72 h if risk (PDPA doc §5), subjects if high risk, post-mortem to `docs/incidents/`.
- **Vault sealed unexpectedly**: check container restart/OOM; gather 3 officers to unseal; if raft data corrupt → restore snapshot (§3).
- **Kiosk offline**: it keeps capturing ≥24 h; fix network; verify spool drain count vs device counter; reconcile in Timesheet exceptions.
- **Payroll discrepancy reported**: never edit committed runs — reproduce via fixture, classify (config vs data vs defect), correct through adjustment run; if statutory config wrong, fix with effective date + governance approval and document in verification log.
- **Lost unseal share**: if ≥3 remain, immediately re-run `./scripts/vault-ceremony.sh --confirm-five-officers-present --force` with a replacement officer to issue a fresh 5-share/threshold-3 set (§2); update `signoff/key-register.md`. If <3 remain, this is not a routine incident — see §2 rule 3.

## 7. Kiosk Hardware Baseline
Android 12+ tablet, 1080p front camera, wall-mounted at ~1.5 m, diffuse frontal lighting (no backlight/window behind users), wired network preferred, kiosk-mode locked launcher, device registered + approved in Admin (per-device secret). Two devices per high-traffic entrance for redundancy.
