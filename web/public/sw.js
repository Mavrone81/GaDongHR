// Minimal PWA service worker: app-shell caching only (no offline API data —
// every screen here reads live, permission-guarded data, which must never
// be served stale from a cache). Registered by src/main.tsx, browser-only.
//
// CACHE_NAME is bumped (v1 -> v2) as part of the fix below, not just a
// version bump for its own sake: bumping it changes this file's bytes,
// which is what makes a browser that already has the old worker installed
// notice an update at all, install the new worker, and run `activate`
// below — which deletes every cache whose name isn't the CURRENT
// `CACHE_NAME`. Without a byte change here, an already-registered worker
// with identical source is never replaced, `activate` never re-runs, and a
// cache poisoned under the old name would keep answering forever.
const CACHE_NAME = 'gadonghr-shell-v2'
const SHELL_ASSETS = ['/', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  // `skipWaiting()` is the other half of the v1 -> v2 fix, not an
  // unrelated hardening. Without it, a corrected worker installs and then
  // sits in `waiting` until every tab with the origin open is closed —
  // standard SW lifecycle, meant to avoid two versions of a page running
  // at once. But EVERY tab still open right now is exactly the tab that
  // registered the OLD cache-first worker during the broken window and is
  // showing the blank page this fix exists to repair; they don't reload
  // their way out, they wait to *close* their way out, which for a
  // sign-in page nobody can get past means never. Calling it here lets
  // the new worker become `active` immediately; `clients.claim()` below
  // (plus the controllerchange-triggered reload in registerServiceWorker.ts)
  // is what makes that active worker actually start controlling — and
  // repairing — those already-open tabs instead of only new ones.
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // `clients.claim()` takes control of every open, in-scope tab right
      // now, instead of only tabs opened AFTER this activation — the
      // default. Pairs with `skipWaiting()` above: that gets this worker
      // to `active` without waiting for tabs to close; this makes it
      // actually control them once it's there. `registerServiceWorker.ts`
      // listens for the `controllerchange` this fires and reloads the
      // page exactly once (guarded via `sessionStorage`, not an in-memory
      // flag, because the reload re-executes that whole module) — taking
      // control alone does not make an already-rendered dead document
      // re-fetch itself.
      self.clients.claim(),
      // Deletes every cache whose name isn't the CURRENT `CACHE_NAME` —
      // for a browser that registered the OLD worker, that's the entire
      // `gadonghr-shell-v1` cache, `/` entry included: `caches.delete`
      // removes the whole named cache object, not selected entries within
      // it, so there is no separate step needed to target `/`
      // specifically. This is also WHY this worker's `activate` runs at
      // all for those browsers in the first place — CACHE_NAME's v1 -> v2
      // bump changed this file's bytes, which is what makes an
      // already-registered worker with otherwise-identical logic notice
      // an update, install, and reach this handler; without that bump,
      // `activate` here would never re-run and the poisoned v1 cache
      // would keep answering forever regardless of `clients.claim()`.
      caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
    ]),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Never intercept API calls (svc-* origins/paths) or navigation to the
  // OIDC callback — only cache same-origin, GET, shell-asset-shaped
  // requests, so an access token is never at risk of being written into
  // the Cache Storage API.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  // NETWORK-FIRST, falling back to cache only when the network is
  // unreachable — THE root cause of the blank-login-page incident this
  // file fixes. `/` was previously served cache-first: once cached at
  // first install, it was never fetched from the network again for that
  // browser, no matter how many deploys followed. Every deploy renames
  // `index.html`'s hashed `/assets/index-*.js`/`.css` references; a
  // browser holding the stale cached `/` kept requesting the OLD, now
  // deleted, hashed filenames. nginx's SPA-fallback `try_files` answered
  // those with a 200 `text/html` copy of the CURRENT `index.html` (never a
  // 404), so the browser saw "200" everywhere and logged nothing — but a
  // `<script type="module">` given a `text/html` body refuses to execute
  // (strict MIME-type checking), React never mounted, and `#root` stayed
  // permanently empty. `fetch(event.request)` first, cache only as an
  // offline fallback, means a returning visitor with network connectivity
  // always gets the CURRENT shell; the cache still serves the last-known
  // shell when there is no network at all, which is the one property this
  // worker exists for.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const responseClone = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone))
        }
        return response
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? Response.error())),
  )
})
