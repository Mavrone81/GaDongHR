import { readFileSync, writeFileSync } from 'node:fs'
import { computePackSignature } from '../packs.service'
import type { PackRecord, SignedPack } from '../packs.service'

/**
 * The on-disk shape of `services/svc-config/seed/*.json` — deliberately has
 * NO `signature` field. See this file's header for why: a signature baked
 * in at authoring time can only ever verify under the one
 * `CONFIG_PACK_SIGNING_KEY` that produced it, which is a different, randomly
 * generated value in every deployed environment (`deploy/.env`'s
 * `CONFIG_PACK_SIGNING_KEY=CHANGE_ME`). A committed field that looks like a
 * signature but is valid nowhere except its author's own machine is worse
 * than no field at all — it reads as a security control while guaranteeing
 * `CFG-401` on every real import. The seed files therefore ship the
 * unsigned content only; this tool is the ONLY supported way to turn that
 * into something `PacksService.importPack` will accept, and it must be run
 * — with the target environment's own key — immediately before import
 * (wired into `deploy/scripts/seed.sh`), never once at authoring time.
 */
export type UnsignedPack = {
  pack_id: string
  version: number
  records: PackRecord[]
}

/**
 * Signs `pack` for `signingKey` by delegating straight to
 * `computePackSignature` — the exact function `PacksService.importPack`
 * calls to verify. Any `signature` already present on the input (e.g. a
 * stale value from a different environment) is ignored: the output's
 * `signature` is always freshly computed from `{pack_id, version, records}`,
 * never carried through. That is the only way to guarantee this tool's
 * output verifies under `signingKey` — reimplementing or "trusting" an
 * existing signature would reintroduce the exact bug this tool exists to
 * fix.
 */
export function signPack(pack: UnsignedPack | SignedPack, signingKey: string): SignedPack {
  const { pack_id, version, records } = pack
  const signature = computePackSignature({ pack_id, version, records }, signingKey)
  return { pack_id, version, records, signature }
}

/** Reads `filePath` (an `UnsignedPack`, or a `SignedPack` whose existing signature is discarded), signs it for `signingKey`, and returns the result — does not touch disk. */
export function signPackFile(filePath: string, signingKey: string): SignedPack {
  const raw = readFileSync(filePath, 'utf8')
  const pack = JSON.parse(raw) as UnsignedPack | SignedPack
  return signPack(pack, signingKey)
}

/** Signs `filePath` for `signingKey` and overwrites it in place with the result, formatted to match the seed files' own style (2-space indent, trailing newline). For manual/ad-hoc re-signing of a writable copy — `seed.sh` itself calls `signPackFile` directly against the read-only in-image `seed/` directory and never writes back to disk (see this file's header). */
export function signPackFileInPlace(filePath: string, signingKey: string): SignedPack {
  const signed = signPackFile(filePath, signingKey)
  writeFileSync(filePath, `${JSON.stringify(signed, null, 2)}\n`, 'utf8')
  return signed
}

function main(argv: string[]): void {
  const signingKey = process.env['CONFIG_PACK_SIGNING_KEY']
  if (!signingKey) {
    console.error('sign-pack: CONFIG_PACK_SIGNING_KEY must be set in the environment (the target deployment\'s key, not a value copied from a seed file).')
    process.exit(1)
  }

  const write = argv.includes('--write')
  const files = argv.filter((a) => a !== '--write')
  if (files.length === 0) {
    console.error('usage: sign-pack [--write] <pack.json> [pack.json ...]')
    console.error('Without --write: prints each file, signed for CONFIG_PACK_SIGNING_KEY, as one JSON line to stdout.')
    console.error('With --write: overwrites each file in place with the signed result.')
    process.exit(1)
  }

  for (const file of files) {
    if (write) {
      const signed = signPackFileInPlace(file, signingKey)
      console.error(`signed (in place): ${file} (${signed.pack_id} v${signed.version}, ${signed.records.length} record(s))`)
    } else {
      const signed = signPackFile(file, signingKey)
      process.stdout.write(`${JSON.stringify(signed)}\n`)
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
}
