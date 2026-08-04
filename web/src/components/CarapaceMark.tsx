import { useId } from 'react'

export type CarapaceMarkTone = 'reversed' | 'ink'

export interface CarapaceMarkProps {
  /** The accessible name (an already-`t()`-resolved string — this component never invents literal text). */
  title: string
  /**
   * `reversed` (default): paper rim, brass scute linework, on a
   * carapace-shadow ground — "what workers see daily" (task brief), the
   * form chosen for the sign-in lockup. `ink` is the same drawing with ink
   * linework on a paper ground, for a light context (e.g. printed or a
   * light-ground header).
   */
  tone?: CarapaceMarkTone
  /** Pixel size (square). Stroke weight thickens as this shrinks so the linework stays legible small — see `strokeWidthFor` below. */
  size?: number
  className?: string
}

/**
 * A rounded-hexagon point set, generated rather than hand-typed so the
 * outer rim and every scute share one formula — a vertex-up hexagon
 * stretched independently on x/y (`rx`/`ry`), rounded at every corner via
 * `strokeLinejoin="round"` on the `<polygon>` this feeds (see the `<svg>`
 * below), which is what gives the "rounded-hexagonal shell" shape without
 * hand-authoring bezier corners.
 */
function hexPoints(cx: number, cy: number, rx: number, ry: number): string {
  return [-90, -30, 30, 90, 150, 210]
    .map((deg) => {
      const rad = (deg * Math.PI) / 180
      const x = cx + rx * Math.cos(rad)
      const y = cy + ry * Math.sin(rad)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

// The unbroken outer rim.
const OUTER_RIM = hexPoints(50, 50, 38, 44)

// Seven scutes — three down the centre, two flanking pairs — one per
// product module (task brief). No head, no legs, no eyes: a shell, not a
// turtle.
const SCUTES: readonly string[] = [
  hexPoints(50, 27, 15, 13), // centre — top
  hexPoints(50, 50, 15, 13), // centre — middle
  hexPoints(50, 73, 15, 13), // centre — bottom
  hexPoints(27, 36, 13, 12), // flanking pair, upper — left
  hexPoints(73, 36, 13, 12), // flanking pair, upper — right
  hexPoints(27, 64, 13, 12), // flanking pair, lower — left
  hexPoints(73, 64, 13, 12), // flanking pair, lower — right
]

/** Thickens below ~32px so the rim/scute linework does not thin into invisibility at small sizes (kiosk badge, favicon-adjacent uses). */
function strokeWidthFor(size: number): number {
  if (size <= 24) return 4.5
  if (size <= 40) return 3.5
  return 2.5
}

/**
 * The carapace mark (DESIGN.md's brand mark, previously designed but never
 * shipped into the product — task brief). Inline SVG so it can be sized
 * and, for the `ink` tone, tinted via `currentColor` like any other icon;
 * the `reversed` tone deliberately pins its rim/scute colors to
 * `--paper`/`--brass` on a `--carapace-shadow` ground rather than
 * inheriting context color, since that exact combination — "paper rim and
 * brass linework on a dark ground" — is the specific mark that was chosen
 * and is not meant to drift with surrounding text color.
 */
export function CarapaceMark({ title, tone = 'reversed', size = 40, className }: CarapaceMarkProps): React.JSX.Element {
  const titleId = useId()
  const reversed = tone === 'reversed'
  const fill = reversed ? 'var(--carapace-shadow)' : 'var(--paper)'
  const rimStroke = reversed ? 'var(--paper)' : 'currentColor'
  const scuteStroke = reversed ? 'var(--brass)' : 'currentColor'
  const strokeWidth = strokeWidthFor(size)

  return (
    <svg
      role="img"
      aria-labelledby={titleId}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      style={{ display: 'block', flexShrink: 0 }}
    >
      <title id={titleId}>{title}</title>
      <polygon points={OUTER_RIM} fill={fill} stroke={rimStroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {SCUTES.map((points) => (
        <polygon key={points} points={points} fill="none" stroke={scuteStroke} strokeWidth={strokeWidth * 0.65} strokeLinejoin="round" />
      ))}
    </svg>
  )
}
