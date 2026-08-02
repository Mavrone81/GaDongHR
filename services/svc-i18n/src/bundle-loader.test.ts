import { join } from 'node:path'
import { loadRawBundles } from './bundle-loader'
import { flattenBundle } from './flatten'

const BUNDLES_DIR = join(__dirname, '..', 'bundles')

describe('loadRawBundles', () => {
  it('reads and parses the real th/en/zh JSON files off disk', () => {
    const raw = loadRawBundles(BUNDLES_DIR)
    expect(typeof raw.th).toBe('object')
    expect(typeof raw.en).toBe('object')
    expect(typeof raw.zh).toBe('object')
  })

  it('every loaded bundle flattens without error (valid shape: strings or nested objects only)', () => {
    const raw = loadRawBundles(BUNDLES_DIR)
    expect(() => flattenBundle(raw.th)).not.toThrow()
    expect(() => flattenBundle(raw.en)).not.toThrow()
    expect(() => flattenBundle(raw.zh)).not.toThrow()
  })
})
