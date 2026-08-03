import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import './primitives.css'

/**
 * "Table — hairline rules, right-aligned numerics with
 * `font-variant-numeric: tabular-nums`" (task brief). A thin wrapper
 * around `<table>`/`<thead>`/`<tbody>` so every table in the app shares
 * one `.table` ruleset; `TableCell`/`TableHeaderCell` add the app-wide
 * `.numeric` utility (`styles/tokens.css`) when `numeric` is set, instead
 * of each screen reinventing tabular-nums styling per column.
 */
export function Table({ caption, children }: { caption?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <table className="table">
      {caption && <caption className="eyebrow">{caption}</caption>}
      {children}
    </table>
  )
}

export function TableHeaderCell({
  numeric = false,
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }): React.JSX.Element {
  const classes = [numeric ? 'numeric' : undefined, className].filter(Boolean).join(' ')
  return <th className={classes || undefined} {...rest} />
}

export function TableCell({
  numeric = false,
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }): React.JSX.Element {
  const classes = [numeric ? 'numeric' : undefined, className].filter(Boolean).join(' ')
  return <td className={classes || undefined} {...rest} />
}
