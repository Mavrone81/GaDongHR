import { createHmac, timingSafeEqual } from 'node:crypto'
import { GadongError, idempotent, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import type { GovernanceClass, NewRuleRow, RuleStatus, StatutoryRuleRow } from './rules.repository'
import { RulesRepository } from './rules.repository'

export interface PackRecord {
  rule_key: string
  value: unknown
  unit: string
  statutory_floor?: unknown
  statutory_ceiling?: unknown
  citation: string
  effective_from: string
  effective_to?: string | null
  governance_class: GovernanceClass
}

export interface SignedPack {
  pack_id: string
  version: number
  signature: string
  records: PackRecord[]
}

export interface PackImportResult {
  packId: string
  version: number
  status: 'imported' | 'duplicate'
  ruleCount: number
}

function packSignatureInvalid(packId: string, version: number): GadongError {
  return new GadongError('CFG-401', 'config.error.pack_signature_invalid', 401, [{ packId, version }])
}

/**
 * Stable string for a pack's signable content — sorts object keys
 * recursively so the same logical content always canonicalises the same
 * way regardless of the order keys happen to appear in the source JSON.
 * Arrays keep their order: record order is part of the signed content.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

/**
 * `HMAC-SHA256(signingKey, canonical_json({pack_id, version, records}))`,
 * base64-encoded. There is no PKI in Phase 1 (roadmap "Contracts every
 * phase depends on" defines none for rule packs); a shared signing key —
 * read from `CONFIG_PACK_SIGNING_KEY`, never hard-coded in production code
 * — is the simplest mechanism that still makes "signature verification
 * failure blocks import" (SEED-DATA-SPEC §4) a real, testable property
 * rather than a checksum a corrupted file would also pass.
 */
export function computePackSignature(pack: Pick<SignedPack, 'pack_id' | 'version' | 'records'>, signingKey: string): string {
  const canonical = canonicalJson({ pack_id: pack.pack_id, version: pack.version, records: pack.records })
  return createHmac('sha256', signingKey).update(canonical).digest('base64')
}

function verifyPackSignature(pack: SignedPack, signingKey: string): boolean {
  const expected = Buffer.from(computePackSignature(pack, signingKey), 'base64')
  const actual = Buffer.from(pack.signature, 'base64')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

function toNewRuleRow(record: PackRecord): NewRuleRow {
  const status: RuleStatus = 'active'
  return {
    ruleKey: record.rule_key,
    value: record.value,
    unit: record.unit,
    statutoryFloor: record.statutory_floor ?? null,
    statutoryCeiling: record.statutory_ceiling ?? null,
    citation: record.citation,
    effectiveFrom: record.effective_from,
    effectiveTo: record.effective_to ?? null,
    governanceClass: record.governance_class,
    status,
    // Pack imports are pre-approved by the signed-artifact + governance
    // approval on the import call itself (Statutory Spec §11.5) — there is
    // no separate propose/approve pair per row, so both sides of the SoD
    // pair are left NULL rather than set to the same importing actor
    // (which the SoD CHECK would reject outright).
    proposedBy: null,
    approvedBy: null,
    reason: null,
  }
}

function floorOrCeilingViolation(record: PackRecord): GadongError | null {
  if (record.governance_class !== 'STATUTORY_FLOOR') return null
  const value = record.value
  const floor = record.statutory_floor
  const ceiling = record.statutory_ceiling
  if (typeof value === 'number' && typeof floor === 'number' && value < floor) {
    return new GadongError('CFG-422', 'config.error.below_statutory_floor', 422, [
      { ruleKey: record.rule_key, value, statutoryFloor: floor, citation: record.citation },
    ])
  }
  if (typeof value === 'number' && typeof ceiling === 'number' && value > ceiling) {
    return new GadongError('CFG-422', 'config.error.above_statutory_ceiling', 422, [
      { ruleKey: record.rule_key, value, statutoryCeiling: ceiling, citation: record.citation },
    ])
  }
  return null
}

/**
 * Loads signed JSON rule packs (`seed/TH-STATUTORY-v1.json`,
 * `seed/TH-HOLIDAYS-2026.json`) via `POST /packs/import`. Idempotent by
 * `(pack_id, version)` (SEED-DATA-SPEC §4) — reusing the kernel's
 * `idempotent()` against `processed_events` rather than a bespoke import-log
 * table: the whole pack import is one logical event, so a second import of
 * the same `(pack_id, version)` is a true no-op, not a second pass of
 * `ON CONFLICT DO NOTHING` inserts that could still change row content.
 *
 * Fails closed on either check, before any row is written: an invalid
 * signature (`CFG-401`) or any record that violates its own statutory
 * floor/ceiling (`CFG-422`, same shape `rules.service.ts` uses) blocks the
 * whole pack — `idempotent()`'s handler only runs inside the caller's
 * transaction, so a thrown error here rolls the transaction back and undoes
 * every row this call would otherwise have written (kernel `withTransaction`).
 */
export class PacksService {
  constructor(
    private readonly repo: RulesRepository,
    private readonly signingKey: string,
  ) {}

  async importPack(tx: Queryable, pack: SignedPack): Promise<PackImportResult> {
    if (!verifyPackSignature(pack, this.signingKey)) {
      throw packSignatureInvalid(pack.pack_id, pack.version)
    }

    for (const record of pack.records) {
      const violation = floorOrCeilingViolation(record)
      if (violation) throw violation
    }

    const eventId = `pack-import:${pack.pack_id}:${pack.version}`
    const outcome = await idempotent(tx, 'config', eventId, async (): Promise<StatutoryRuleRow[]> => {
      const inserted: StatutoryRuleRow[] = []
      for (const record of pack.records) {
        inserted.push(await this.repo.insert(tx, toNewRuleRow(record)))
      }
      if (inserted.length > 0) {
        await writeOutbox(tx, 'config', 'rules.updated', {
          ruleKeys: [...new Set(inserted.map((r) => r.ruleKey))],
          effectiveFrom: pack.records[0]?.effective_from ?? null,
        })
      }
      return inserted
    })

    if (outcome === 'duplicate') {
      return { packId: pack.pack_id, version: pack.version, status: 'duplicate', ruleCount: 0 }
    }
    return { packId: pack.pack_id, version: pack.version, status: 'imported', ruleCount: outcome.length }
  }
}
