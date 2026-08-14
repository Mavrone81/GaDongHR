/**
 * Design tokens, ported verbatim from `web/DESIGN.md` ("Direction 1,
 * Official Record") and `web/src/styles/tokens.css` — same hex values, same
 * spacing scale, same reserved-seal rule. React Native has no CSS custom
 * properties, so this is the one module every themed component imports
 * from instead of hand-typing a hex value — the mobile equivalent of
 * `tokens.css` being the only place those literals may appear.
 *
 * `SEAL` is reserved for statutory citations ONLY — never a general accent
 * (DESIGN.md: "the moment it appears on something that is not a legal
 * citation, the citation stops reading as special and the direction's
 * whole argument collapses"). `noSealOutsideSeal.test.ts` mirrors web's
 * test of the same name, scanning for stray `SEAL`/`colors.seal` references
 * outside `components/Seal.tsx`.
 */
export const colors = {
  paper: '#FCFBF7',
  ink: '#171614',
  rule: '#DBD5C6',
  seal: '#A8322A',
  carapace: '#1B4A3C',
  brass: '#C08A3E',
  muted: '#6E685C',
  /** Kiosk mode is deliberately dark (DESIGN.md, "Two deliberate departures"). */
  carapaceShadow: '#102A22',
} as const;

/** Spacing scale — rem values in `tokens.css` become fixed px here (RN has no root font-size to scale against); 1rem == 16px, matching the web body font-size. */
export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 40,
} as const;

/**
 * DESIGN.md's Type section calls for Sarabun across all three scripts —
 * the Thai government's own document typeface — "never rely on a system
 * fallback for Thai". Embedding it is an asset task (licensed font
 * binaries), not source; it is NOT done here — see
 * `.superpowers/sdd/02-modules/mobile-app.md`'s unverified list. Today this
 * falls back to each platform's system font (San Francisco / Roboto),
 * which DOES render Thai correctly (both ship full Thai coverage), just
 * not in Sarabun. Swapping in real Sarabun later is: drop the four static
 * weights into `assets/fonts/`, load them with `expo-font`'s `useFonts` in
 * `App.tsx`, and change `body`/`bodyBold` below to the loaded family names
 * — no other file needs to change, every screen already reads fonts from
 * here rather than hard-coding a family name.
 */
export const fonts = {
  body: undefined,
  bodyBold: undefined,
  mono: 'Courier',
} as const;

/**
 * Thai vowel/tone marks stack above and below the line — looser leading
 * than Latin needs (DESIGN.md, "Non-negotiables": "do not set Thai at the
 * Latin line-height and hope"). `lineHeightFor(locale, fontSize)` below is
 * how screens apply this without repeating the ratio at every call site.
 */
export const leading = {
  body: 1.7,
  latin: 1.45,
} as const;

export function lineHeightFor(locale: 'th' | 'en' | 'zh', fontSize: number): number {
  const ratio = locale === 'th' ? leading.body : leading.latin;
  return Math.round(fontSize * ratio);
}

export const radii = {
  /** DESIGN.md: "No cards, no shadows, no rounded containers — this is a document, not a dashboard." Zero everywhere except the one deliberate kiosk-mode punch button (see KioskScreen). */
  none: 0,
} as const;

export type ColorToken = keyof typeof colors;
