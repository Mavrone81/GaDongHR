import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `pnpm typecheck` runs `tsc -b` against the root solution tsconfig, which only
 * builds the projects named in its `references` array. A workspace package that
 * is missing from that array is never typechecked and never complains — the
 * failure is silent. This test is the alarm.
 */
describe('root tsconfig references', () => {
  const root = join(__dirname, '..', '..', '..')

  const workspacePackages = (): string[] =>
    ['packages', 'services'].flatMap((dir) => {
      const abs = join(root, dir)
      if (!existsSync(abs)) return []
      return readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(abs, e.name, 'tsconfig.json')))
        .map((e) => `./${dir}/${e.name}`)
    })

  it('references every workspace package that has a tsconfig', () => {
    const rootConfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as {
      references?: { path: string }[]
    }
    const referenced = new Set((rootConfig.references ?? []).map((r) => r.path.replace(/\/$/, '')))
    const missing = workspacePackages().filter((p) => !referenced.has(p))
    expect(missing).toEqual([])
  })
})
