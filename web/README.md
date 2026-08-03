# web

No UI lives here yet (that's Phase 1.5 onward). This directory currently holds only the
**UI-coverage gate**: `ui-coverage.json` maps every HTTP route in the system to a screen or an
explicit exemption, and `ui-coverage.test.ts` enforces it by re-parsing every
`services/**/*.controller.ts` and failing on any mismatch. See
`docs/superpowers/plans/00-PROGRAM-ROADMAP.md`, "Every endpoint has a front end — enforced, not
intended", for why this exists.

## Adding an endpoint without breaking the gate

1. Add the `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` route to your controller as normal.
2. Add one entry to `ui-coverage.json`'s `routes` array with matching `service`/`method`/`path`.
3. Either point it at a screen (`"screen": "/admin/whatever"`, plus the guarding `"permission"`,
   which must already be in the roadmap's permission catalog) or mark it `"exempt"` with a
   non-empty `"reason"` — `exempt` must be exactly one of `service-to-service`, `operational`, or
   `consumed-not-displayed`. "Not needed yet" is not a reason; that's a missing screen.
4. Reuse an existing `screen` route where the endpoint belongs with something already there (e.g.
   a new statutory-rules route belongs on `/admin/statutory-rules`) rather than inventing a new one.
5. Run `pnpm test -- web/ui-coverage.test.ts` — it fails and names the exact route if you skipped
   a step above.
