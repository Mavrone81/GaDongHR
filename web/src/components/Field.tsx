import type { ReactNode } from 'react'
import './primitives.css'

/**
 * DESIGN.md's "Layout": "Label left, value right, hairline between. […]
 * No cards, no shadows, no rounded containers — this is a document, not a
 * dashboard." This is that ruled row — the basic unit of every screen in
 * this app. `label` is a caller-resolved `t()` string, not literal text.
 */
export function Field({
  label,
  htmlFor,
  numeric = false,
  children,
}: {
  label: string
  htmlFor?: string
  numeric?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className={numeric ? 'field__value field__value--numeric' : 'field__value'}>{children}</div>
    </div>
  )
}
