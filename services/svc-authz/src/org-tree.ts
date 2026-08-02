/**
 * A minimal, schema-agnostic view of `authz.org_unit` — just enough to walk
 * the tree. Pure and dependency-free (Task 8 brief: "everything depends on
 * it") so it can be unit-tested without a database, real or fake.
 */
export interface OrgUnitNode {
  id: string
  parentId: string | null
}

/**
 * The exact set of ids reachable by descending from `rootId`: `rootId`
 * itself plus every child, grandchild, etc. Never walks upward — this is
 * the single property this task's "org scoping is a subtree" requirement
 * rests on (Task 8 brief §4, property 3). A manager granted at "Chonburi
 * plant" must see that unit and everything under it, and *nothing* above or
 * beside it: the parent, and any sibling, must never appear in the result.
 *
 * Defensive, not because the schema allows it, but because this function is
 * the one thing standing between a data bug and a permission leak:
 *  - `rootId` need not appear in `units` at all — a unit with no known
 *    children still resolves to `[rootId]`, never an error and never an
 *    empty result that a caller might read as "no scope" or "everyone".
 *  - a cyclic `parentId` chain (corrupt data) cannot infinite-loop this
 *    walk — `seen` guards every push exactly once.
 */
export function subtreeIds(rootId: string, units: OrgUnitNode[]): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const unit of units) {
    if (unit.parentId === null) continue
    const children = childrenByParent.get(unit.parentId)
    if (children) children.push(unit.id)
    else childrenByParent.set(unit.parentId, [unit.id])
  }

  const seen = new Set<string>()
  const result: string[] = []
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    result.push(id)
    for (const childId of childrenByParent.get(id) ?? []) {
      if (!seen.has(childId)) stack.push(childId)
    }
  }
  return result
}
