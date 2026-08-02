import { subtreeIds } from './org-tree'
import type { OrgUnitNode } from './org-tree'

/**
 * Fixture (Task 8 brief §4, property 3 — "a three-level fixture"):
 *
 *   company
 *   ├── bangkok-region
 *   │    └── bangkok-hq
 *   └── chonburi-region
 *        ├── chonburi-office
 *        │    └── chonburi-plant
 *        │         ├── chonburi-plant-line-a
 *        │         └── chonburi-plant-line-b
 *        └── chonburi-warehouse
 *
 * `chonburi-warehouse` exists solely to give `chonburi-office` a real
 * sibling under a shared parent (`chonburi-region`) — the exact shape the
 * brief warns about ("an off-by-one there is how a line manager sees the
 * whole company").
 */
const TREE: OrgUnitNode[] = [
  { id: 'company', parentId: null },
  { id: 'bangkok-region', parentId: 'company' },
  { id: 'bangkok-hq', parentId: 'bangkok-region' },
  { id: 'chonburi-region', parentId: 'company' },
  { id: 'chonburi-office', parentId: 'chonburi-region' },
  { id: 'chonburi-warehouse', parentId: 'chonburi-region' },
  { id: 'chonburi-plant', parentId: 'chonburi-office' },
  { id: 'chonburi-plant-line-a', parentId: 'chonburi-plant' },
  { id: 'chonburi-plant-line-b', parentId: 'chonburi-plant' },
]

/** Order-independent set comparison — `subtreeIds` makes no ordering promise. */
function expectSameSet(actual: string[], expected: string[]): void {
  expect(new Set(actual)).toEqual(new Set(expected))
  expect(actual).toHaveLength(expected.length)
}

describe('subtreeIds', () => {
  it('a leaf unit with no children returns only itself', () => {
    expectSameSet(subtreeIds('chonburi-plant-line-a', TREE), ['chonburi-plant-line-a'])
  })

  it('every descendant (children and grandchildren) is included', () => {
    expectSameSet(subtreeIds('chonburi-office', TREE), [
      'chonburi-office',
      'chonburi-plant',
      'chonburi-plant-line-a',
      'chonburi-plant-line-b',
    ])
  })

  it('the exact set for a mid-tree grant — nothing above it, nothing beside it', () => {
    expectSameSet(subtreeIds('chonburi-plant', TREE), [
      'chonburi-plant',
      'chonburi-plant-line-a',
      'chonburi-plant-line-b',
    ])
  })

  it('the parent of the granted unit is excluded (boundary: nothing above)', () => {
    const result = subtreeIds('chonburi-plant', TREE)
    expect(result).not.toContain('chonburi-office')
    expect(result).not.toContain('chonburi-region')
    expect(result).not.toContain('company')
  })

  it('a sibling of the granted unit is excluded (boundary: nothing beside)', () => {
    const result = subtreeIds('chonburi-office', TREE)
    expect(result).not.toContain('chonburi-warehouse')
  })

  it('a grant at the root includes the entire tree', () => {
    expectSameSet(
      subtreeIds('company', TREE),
      TREE.map((u) => u.id),
    )
  })

  it('a grant on a unit not present in the tree at all returns just that id (defensive: never throws, never silently expands)', () => {
    expectSameSet(subtreeIds('unknown-unit', TREE), ['unknown-unit'])
  })

  it('is stable against a cyclic parent chain (defensive: must not infinite-loop on bad data)', () => {
    const cyclic: OrgUnitNode[] = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]
    expectSameSet(subtreeIds('a', cyclic), ['a', 'b'])
  })
})
