import type { ButtonHTMLAttributes } from 'react'
import './primitives.css'

export type ButtonVariant = 'primary' | 'secondary' | 'quiet'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

/**
 * The three button treatments DESIGN.md calls for: primary (carapace
 * ground, for the one committing action on a screen), secondary (outline,
 * for a peer action), and quiet (text-only, for a dismissive or low-stakes
 * one — Cancel, a locale toggle). None of the three ever uses `--seal`:
 * that color is reserved for `Seal` alone, including destructive actions
 * (DESIGN.md: "Not for errors, not for destructive actions, not for a
 * delete button"). Focus is the shared `:focus-visible` ring from
 * `styles/tokens.css`, not a variant-specific one.
 */
export function Button({ variant = 'secondary', className, type = 'button', ...rest }: ButtonProps): React.JSX.Element {
  const classes = ['btn', `btn--${variant}`, className].filter(Boolean).join(' ')
  return <button type={type} className={classes} {...rest} />
}
