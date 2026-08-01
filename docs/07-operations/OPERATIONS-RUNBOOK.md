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

`vault-init.sh` initialises Vault with **5 Shamir unseal shares, threshold 3**, creates transit KEKs per data class, and the AppRole for `svc-crypto` (secret → `deploy/secrets/vault_approle_secret`).

Rules:
1. Each share goes to a **different named key officer** (print/QR to paper or hardware token — never stored on the host, never in chat/email).
2. Record officers' names in the key register (template `signoff/key-register.md`).
3. **Loss of 3+ shares = permanent loss of all encrypted data.** There is no vendor backdoor — say this out loud in the ceremony.
4. After host reboot Vault starts **sealed**: 3 officers run `docker compose exec vault vault operator unseal` (once each). Until unsealed, sensitive-field operations return 503 by design (fail closed).
5. Rotate the AppRole secret quarterly (`scripts/rotate-approle.sh`); rotate KEK versions yearly (`scripts/rotate-keks.sh` — re-wraps, no downtime).

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
- **Lost unseal share**: if ≥3 remain, immediately `vault operator rekey` to issue a fresh share set; update key register.

## 7. Kiosk Hardware Baseline
Android 12+ tablet, 1080p front camera, wall-mounted at ~1.5 m, diffuse frontal lighting (no backlight/window behind users), wired network preferred, kiosk-mode locked launcher, device registered + approved in Admin (per-device secret). Two devices per high-traffic entrance for redundancy.
