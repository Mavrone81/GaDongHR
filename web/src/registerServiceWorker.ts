// Registers `public/sw.js` and, for a tab that was already controlled by
// an older worker, makes the corrected worker's takeover actually repair
// the page — not just the ability to register the fix.
//
// `sw.js`'s `activate` handler now calls `self.clients.claim()` (see that
// file's header) so an updated worker takes control of already-open tabs
// instead of waiting for every tab on the origin to close first —
// otherwise anyone who visited during the blank-page window (the bug
// commit 7ee945b fixed) stays stuck on the OLD cache-first worker,
// reloading the same dead tab forever without it ever re-fetching
// `index.html` from the network.
//
// But `clients.claim()` only changes WHICH worker controls the page — it
// does not make an already-rendered, already-dead document re-fetch
// itself. The browser fires `controllerchange` on `navigator.serviceWorker`
// exactly once per takeover; reloading in response to it is what actually
// repairs the tab.
//
// Two guards keep this from being worse than the bug it fixes:
//
// 1. `serviceWorkerContainer.controller` is only truthy if THIS load was
//    already controlled by a worker before `register()` below runs — a
//    brand-new visitor (nothing installed yet) has no controller, so the
//    listener below is never even attached for them. Without this check,
//    `clients.claim()` also fires `controllerchange` the very FIRST time a
//    previously-uncontrolled page gets a controller, which would reload
//    every first-time visitor for no reason.
// 2. `storage` (`sessionStorage` in production — see `main.tsx`), not a
//    module-level variable, records that the reload already happened. A
//    module-level/in-memory flag would be useless here: `reload()` (i.e.
//    `location.reload()`) re-executes this module from scratch, wiping
//    any in-memory state, so an in-memory guard would re-arm on every
//    reload — a loop, which is STRICTLY WORSE than the blank page this
//    fixes. `sessionStorage` survives the reload (scoped to the tab, not
//    to a script instance), so the flag set immediately before reloading
//    is still there on the next module instance, and the listener it
//    installs is a no-op for the rest of the tab's life. Proven by
//    `registerServiceWorker.test.ts`'s "cross-reload guard" and "fires at
//    most once" cases, which construct a second `registerServiceWorker`
//    call against storage that already has the flag set — exactly what a
//    fresh module instance sees after `location.reload()`.
const RELOAD_FLAG_KEY = 'gadonghr:sw-reloaded'

export interface ReloadGuardStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

// A minimal slice of `ServiceWorkerContainer`, not the full DOM type: this
// is the whole reason `registerServiceWorker` is a separate, injectable
// module rather than inline code in `main.tsx` — a real
// `navigator.serviceWorker` can't be constructed in a Vitest/jsdom test,
// but a plain object implementing just these three members can, letting
// `registerServiceWorker.test.ts` exercise the reload-guard logic against
// a real (if fake) `EventTarget` instead of mocking the browser.
export interface ServiceWorkerContainerLike extends EventTarget {
  register(scriptUrl: string): Promise<unknown>
  readonly controller: unknown
}

export function registerServiceWorker(
  serviceWorkerContainer: ServiceWorkerContainerLike,
  storage: ReloadGuardStorage,
  reload: () => void,
): void {
  void serviceWorkerContainer.register('/sw.js')

  if (!serviceWorkerContainer.controller) return

  let hasReloaded = storage.getItem(RELOAD_FLAG_KEY) === '1'
  serviceWorkerContainer.addEventListener('controllerchange', () => {
    if (hasReloaded) return
    hasReloaded = true
    storage.setItem(RELOAD_FLAG_KEY, '1')
    reload()
  })
}
