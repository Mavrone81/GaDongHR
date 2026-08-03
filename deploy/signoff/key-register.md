# GaDongHR — Vault Key Officer Register

Runbook §2's required template. One row per key officer, filled in and
signed as part of `vault-ceremony.sh` (`deploy/scripts/vault-ceremony.sh`)
— never before shares exist, never from memory afterwards.

This file is committed to git. **Never put a share, a fingerprint's
private-key material, a PGP passphrase, or any Vault key value in this
file or in this repository, ever.** Only the fields below.

## THE CONSEQUENCE — READ THIS OUT LOUD BEFORE THE CEREMONY STARTS

Vault is rekeyed to **5 shares, threshold 3**. Any 3 of the 5 officers
below, acting together, can unseal Vault or authorise a future rekey.
**Losing 3 of the 5 shares is permanent, irreversible loss of every
encrypted field in GaDongHR** — national IDs, bank accounts, salaries,
health attachments, face-template references, all of it, forever.
**There is no vendor backdoor.** GaDongHR cannot recover it. HashiCorp
cannot recover it. This is not a hypothetical or a worst case to plan
around — it is the direct, intended mathematical consequence of Shamir
secret sharing with threshold 3, and it is why 5 separate, named,
accountable people hold one piece each instead of one person or one
system holding all of it. Say this sentence out loud, in the room, before
the first share is generated: **if we lose three of these five shares, we
lose everything Vault protects, permanently, and no one can undo that.**

## Officers

| # | Officer Name | Role | Contact | PGP Fingerprint | Share File | Date Issued | Signature |
|---|---|---|---|---|---|---|---|
| 1 | | | | | `<officer-slug>.share.b64` | | |
| 2 | | | | | `<officer-slug>.share.b64` | | |
| 3 | | | | | `<officer-slug>.share.b64` | | |
| 4 | | | | | `<officer-slug>.share.b64` | | |
| 5 | | | | | `<officer-slug>.share.b64` | | |

- **Officer Name** — full legal name, not a title or team alias.
- **Role** — their function at GaDongHR / the customer org (e.g. IT
  Director, DPO, external auditor). Chosen for accountability and
  availability, not convenience — see "Composition" below.
- **Contact** — a channel that reaches THEM specifically (not a shared
  inbox), for the quarterly re-attestation below.
- **PGP Fingerprint** — the full fingerprint of the public key they
  supplied in `deploy/signoff/pgp-keys/<officer-slug>.asc` before the
  ceremony (`gpg --fingerprint <key>`). Verify this matches what
  `vault-ceremony.sh` printed for their share — a fingerprint mismatch
  means the wrong key was used and the share must be regenerated.
- **Share File** — the exact filename `vault-ceremony.sh` wrote under
  `deploy/signoff/shares/`. Recorded here for audit only — the file
  itself must be off this host (see rules below) by the time this row is
  signed.
- **Date Issued** — the date this officer confirmed successful local
  decryption (`base64 -d <file> | gpg --decrypt`), not the date the
  ceremony script ran.
- **Signature** — physical or digital signature confirming: "I have
  received my share, decrypted it successfully with my own private key,
  and understand the consequence stated above."

## Composition rule

No 3 of the 5 officers should be able to be rendered unavailable by a
single event (one team, one building, one employer). Prefer a mix that
includes at least one person outside GaDongHR's own operations team
(e.g. the customer's DPO or an external auditor) — a threshold made
entirely of one team's own staff defeats part of the point of a
threshold.

## Standing rules (apply for the life of this Vault instance)

1. **Shares never on the host.** Not `gadonghr-prod`, not a laptop that
   also touches production, not a shared drive. Once an officer confirms
   decryption, the ceremony-host copy under `deploy/signoff/shares/` is
   deleted (`vault-ceremony.sh`'s own printed instructions say this).
2. **Shares never in chat or email**, encrypted or not. Hand-delivered or
   over a channel already trusted with this class of secret, in person
   or via an already-established secure channel — never Slack, never a
   mail attachment, never a shared paste.
3. **No officer holds two shares.** Ever, for any reason, including a
   temporary vacancy. A vacant seat is filled by re-rekeying with a new
   5th officer, not by doubling up an existing one — doubling up quietly
   turns a 3-of-5 threshold into an effective 3-of-4 or worse.
4. **Quarterly re-attestation.** Every quarter, each officer confirms in
   writing (via their Contact channel above) that they (a) still hold
   their share, (b) it is still stored per rule 1, and (c) their contact
   details here are current. Record the attestation date in a dated note
   appended below this file's officer table — do not overwrite the
   original issue row. A missed attestation is escalated, not ignored:
   an officer who can no longer confirm their share should be treated as
   a lost-share event and the recovery/re-rekey plan below considered.
5. **Losing a share**: if fewer than 3 remain confirmed-available, this
   is an emergency — GaDongHR is at risk of permanent data loss and
   should treat it with the same urgency as an active incident (Runbook
   §6). If 3+ remain, run `vault-ceremony.sh --force` (Runbook §2) to
   rekey to a fresh 5-of-3 set with a replacement officer, and update
   this register — do not leave a stale row for someone no longer
   holding a valid share.

## Re-attestation log

| Quarter | Date | Officer | Confirmed (Y/N) | Notes |
|---|---|---|---|---|
| | | | | |
