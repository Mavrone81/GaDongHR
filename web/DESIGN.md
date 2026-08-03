# GaDongHR — design system

**Chosen 2026-08-03: Direction 1, Official Record (ราชการ).**

The interface borrows the visual language Thai employers already handle every month — สปส.1-10,
ภ.ง.ด.1, 50 ทวิ. Ruled fields, a form number in the corner, a red seal on any number the law sets.
The bet: in a market where compliance is the reason to buy, looking like the paperwork is a feature.

## Tokens

```
--paper      #FCFBF7   backgrounds
--ink        #171614   body text
--rule       #DBD5C6   hairlines between fields
--seal       #A8322A   statutory citations ONLY — never a general accent
--carapace   #1B4A3C   primary actions, from the brand mark
--brass      #C08A3E   the "HR" in the wordmark, sparing highlights
--muted      #6E685C   secondary text
```

`--seal` is reserved. The moment it appears on something that is not a legal citation, the citation
stops reading as special and the direction's whole argument collapses.

## Type

Sarabun across all three scripts — it is the Thai government's own document typeface and carries a
Latin companion good enough for English. Mono (`ui-monospace`) for rule keys and form numbers.
Embed Sarabun, Noto Sans SC and Noto Sans; never rely on a system fallback for Thai.

## Layout

Label left, value right, hairline between. Form number as eyebrow. No cards, no shadows, no
rounded containers — this is a document, not a dashboard.

## The signature element

**The citation seal.** A small red stamp attached to any figure the law sets, carrying the section
and the floor: `§ LPA s.32 · floor 30`. It resolves from `svc-config`, effective-dated — it is not
decoration, it is the same data that blocks an amendment below the statutory floor.

## Two deliberate departures

1. **Kiosk mode is dark** (`--carapace-shadow #102A22`, brass linework). Different physics: a
   wall-mounted tablet at 1.5 m, glanced at while walking, often backlit. Borrowed from Direction 2.
2. **Numerics are Ledger's.** Tabular figures, right-aligned money, the rule key under the label.
   Not a visual direction — hygiene, and it applies everywhere. Borrowed from Direction 3.

## Non-negotiables

- Every string through `svc-i18n`. No hard-coded user-visible text, in any language.
- No business logic in the UI. No statutory value, OT multiplier, tax bracket or accrual rule
  computed in React. Buddhist Era and THB formatting come from `@gadong/kernel`'s `i18n/format`.
- Thai needs looser leading than Latin — vowel and tone marks stack above and below the line.
  Do not set Thai at the Latin line-height and hope.
- Dates: Thai renders Buddhist Era (พ.ศ. = C.E. + 543); English and Chinese render Gregorian.
  Never store B.E.
