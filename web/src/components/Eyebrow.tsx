import type { ElementType, ReactNode } from 'react'
import './primitives.css'

/**
 * DESIGN.md's "Layout": "Form number as eyebrow" — the small uppercase mono
 * label every screen carries (a brand mark, a section title, a form
 * number). Renders whatever `children` the caller already resolved through
 * `t()`; this component never introduces its own literal text.
 */
export function Eyebrow({
  as = 'p',
  children,
}: {
  as?: ElementType
  children: ReactNode
}): React.JSX.Element {
  const Tag = as
  return <Tag className="eyebrow">{children}</Tag>
}
