# GaDongHR — Vault server config (Task 13)
#
# Mounted read-only into the `vault` container at /vault/config/vault.hcl
# (docker-compose.yml). Backs `svc-crypto`, the only Vault client in the
# system (roadmap service #1) — every S2/S3 field's envelope encryption
# and blind-index HMAC ultimately depends on this Vault instance being
# reachable and unsealed.
#
# ============================================================================
# THE SINGLE MOST CONSEQUENTIAL FACT IN THIS REPOSITORY
#
# This Vault is initialised with 5 Shamir unseal key shares, threshold 3
# (Runbook §2, `vault-init.sh` ceremony — out of scope for this task, see
# `deploy/README.md`). There is NO auto-unseal mechanism configured here
# (no `seal "awskms"` / `seal "transit"` / cloud-KMS stanza) — unsealing
# is a deliberate, human, quorum action every time this process starts.
#
# LOSS OF 3 OR MORE OF THE 5 UNSEAL SHARES IS PERMANENT, IRREVERSIBLE LOSS
# OF EVERY ENCRYPTED FIELD IN THE SYSTEM. National IDs, bank accounts,
# salaries, health attachments, face-template references — all of it,
# forever, with no vendor backdoor and no recovery path. This is not a
# hypothetical: it is the direct, designed consequence of Shamir secret
# sharing with threshold 3 protecting the KEKs that wrap every S2/S3
# field's data-encryption key. Say this out loud in the key ceremony
# (Runbook §2 rule 3) before a single share is generated.
#
# A SEALED Vault after every host reboot is BY DESIGN, not a bug: 3 of the
# 5 key officers each run `vault operator unseal` once. Until that happens,
# `/health` for every service that touches Vault reports `degraded`
# (`packages/kernel/src/health.ts`'s `buildHealth` — "must not look like a
# crashed container"), and `svc-crypto` fails closed (503, `CRY-503`) on
# every S2/S3 operation — never a plaintext fallback. `degraded` is the
# correct, safe state for an unattended reboot; it is not "broken".
# ============================================================================

# Single-node Raft (integrated) storage — no external Consul dependency,
# matching the single-droplet, no-shared-infrastructure deployment target
# (Task 13 brief: dedicated `gadonghr-prod`, not a shared box). State lives
# on the `vault_data` named volume (docker-compose.yml) — `docker compose
# down -v` would destroy it, which is exactly why that command is a
# standing "never" (roadmap "Standing constraints": "Never `docker compose
# down -v`. Losing `vault_data` is permanent loss of every encrypted
# field.").
storage "raft" {
  path    = "/vault/data"
  node_id = "gadonghr-vault-1"
}

# Vault's own HTTP listener. TLS is terminated by Traefik at the edge
# (Task 13 brief: "dedicated, so Traefik owns :80/:443 and terminates TLS
# ... there is no host nginx and no port overlay") — Vault itself is never
# reachable from outside the `internal` compose network, only from
# `svc-crypto` and from an operator running `docker compose exec vault
# vault operator unseal`/`vault status` inside the network. `tls_disable`
# here describes the listener's own transport, not the boundary an
# external caller crosses — there is no external caller.
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

# Needed for Raft to advertise itself to (a currently nonexistent, but
# future-possible) second node, and required by Vault even in single-node
# Raft mode for the storage backend to start cleanly.
api_addr     = "http://vault:8200"
cluster_addr = "http://vault:8201"

# disable_mlock — Task 16, decided deliberately, not mechanically.
#
# What actually happened on gadonghr-prod (four attempts, in order): a
# fresh `vault_data` named volume is root-owned, so uid 100 (the image's
# `vault` user) got `permission denied` opening `vault.db`. Fixed (see the
# ownership fix below). Then, with `disable_mlock = false` and
# `cap_add: [IPC_LOCK]` (both still true in name only at that point), Vault
# still crash-looped: the entrypoint runs as root, calls
# `setcap cap_ipc_lock=+ep` on the `vault` binary, then `su-exec vault ...`
# to drop to uid 100 — and `security_opt: ["no-new-privileges:true"]`
# (inherited by every service from `node-defaults`, docker-compose.yml)
# makes the kernel refuse to honour that file capability at that su-exec's
# execve(), by design (`man 2 prctl`, PR_SET_NO_NEW_PRIVS: file
# capabilities are not honoured once no_new_privs is set) — regardless of
# `cap_add`. So the non-root Vault process never actually held
# CAP_IPC_LOCK, and `disable_mlock = false` failed hard: "Failed to lock
# memory... please enable mlock or set disable_mlock".
#
# The other way to close that gap — drop `no-new-privileges` for just the
# `vault` service (Compose needs `!override` on the list, since `!reset`/
# `!override` is the only way an override file actually replaces rather
# than merges a list here, confirmed by this repo's own
# `docker-compose.prod.yml` doing exactly that for `build:`) — was
# considered and rejected: it carves a permanent hardening exception into
# the one service that holds every unseal key and every S2/S3 KEK, for a
# guarantee (mlock) HashiCorp itself does not consider load-bearing in a
# container. The official Vault Helm chart ships `disable_mlock = true`
# for exactly this reason. This file follows that precedent instead:
# `disable_mlock = true`, no capability exception, `no-new-privileges`
# stays on for `vault` exactly like every other service in this file
# (`compose-validation.test.ts` asserts this — no silent, spreadable
# exception).
#
# THE HONEST COST, not a formality: with mlock disabled, Vault's in-memory
# unseal/master key material CAN be paged to the host's swap device, where
# it persists on disk after the process dies (or the host reboots) until
# overwritten. This is a genuine weakening of this specific process's
# memory hygiene, not a paperwork risk — this droplet runs with swap
# enabled. The accepted mitigation is host-level, not process-level:
# `docs/07-operations/OPERATIONS-RUNBOOK.md`'s own prerequisite line
# recommends LUKS full-disk encryption on the host, which covers the swap
# device too — an attacker who doesn't already have the encrypted disk (or
# a live root shell, at which point mlock was never the binding control
# anyway) cannot recover a leaked key from swap. If this droplet is ever
# provisioned without LUKS, that gap is real and open; it is not closed by
# this config file, only by the host's disk encryption.
disable_mlock = true

# Audit device — every Vault request (not just svc-crypto's transit
# encrypt/decrypt/HMAC calls, every request including failed auth) is
# logged. Enabled via `vault audit enable file file_path=/vault/logs/audit.log`
# as part of `vault-init.sh` (Runbook §2), not here — `audit` stanzas are
# not a supported top-level block in this config file; server config only
# gets the process ready to accept that enable call once unsealed.
# Recorded here so the requirement is not lost between this file and the
# ceremony script.

# UI left off deliberately: no browser-facing attack surface for a service
# with no human end users on this droplet (only svc-crypto's AppRole and
# 3 key officers running unseal from inside the container ever talk to
# this Vault).
ui = false

# `default_lease_ttl`/`max_lease_ttl` intentionally left at Vault's own
# defaults — Task 13 scope is the raft/listener/audit skeleton the
# ceremony script (out of scope here, see `deploy/README.md`) needs to run
# against; per-secret-engine TTL tuning belongs with the KEK and AppRole
# setup that script performs, not this static file.
