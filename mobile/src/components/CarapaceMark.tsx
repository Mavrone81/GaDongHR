import React from 'react';
import Svg, { Polygon } from 'react-native-svg';
import { colors } from '../theme/tokens';

/**
 * Ported from `web/src/components/CarapaceMark.tsx` — same generated
 * rounded-hexagon point set (one formula for the outer rim and all seven
 * scutes), same two tones. `react-native-svg`'s `<Svg>`/`<Polygon>` stand
 * in for the DOM `<svg>`/`<polygon>` web uses; there is no CSS custom
 * property indirection here (RN has none), so `reversed`/`ink` read
 * straight from `theme/tokens.ts`'s `colors` instead of `var(--paper)` etc.
 *
 * `reversed` (default) is the primary brand lockup for this app — "the
 * attendance kiosk runs dark; this is the version workers see daily" (task
 * brief) — paper rim, brass scute linework, on a carapace-shadow ground.
 * `ink` is the same drawing with ink linework on a paper ground, for a
 * light-ground header.
 */
export type CarapaceMarkTone = 'reversed' | 'ink';

export interface CarapaceMarkProps {
  /** The accessible name — an already-`t()`-resolved string, this component never invents literal text. */
  title: string;
  tone?: CarapaceMarkTone;
  /** Pixel size (square). Stroke weight thickens as this shrinks so the linework stays legible small. */
  size?: number;
}

function hexPoints(cx: number, cy: number, rx: number, ry: number): string {
  return [-90, -30, 30, 90, 150, 210]
    .map((deg) => {
      const rad = (deg * Math.PI) / 180;
      const x = cx + rx * Math.cos(rad);
      const y = cy + ry * Math.sin(rad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

const OUTER_RIM = hexPoints(50, 50, 38, 44);

const SCUTES: readonly string[] = [
  hexPoints(50, 27, 15, 13),
  hexPoints(50, 50, 15, 13),
  hexPoints(50, 73, 15, 13),
  hexPoints(27, 36, 13, 12),
  hexPoints(73, 36, 13, 12),
  hexPoints(27, 64, 13, 12),
  hexPoints(73, 64, 13, 12),
];

function strokeWidthFor(size: number): number {
  if (size <= 24) return 4.5;
  if (size <= 40) return 3.5;
  return 2.5;
}

export function CarapaceMark({ title, tone = 'reversed', size = 40 }: CarapaceMarkProps): React.JSX.Element {
  const reversed = tone === 'reversed';
  const fill = reversed ? colors.carapaceShadow : colors.paper;
  const rimStroke = reversed ? colors.paper : colors.ink;
  const scuteStroke = reversed ? colors.brass : colors.ink;
  const strokeWidth = strokeWidthFor(size);

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      accessibilityRole="image"
      accessibilityLabel={title}
    >
      <Polygon points={OUTER_RIM} fill={fill} stroke={rimStroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {SCUTES.map((points) => (
        <Polygon key={points} points={points} fill="none" stroke={scuteStroke} strokeWidth={strokeWidth * 0.65} strokeLinejoin="round" />
      ))}
    </Svg>
  );
}
