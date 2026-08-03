// Minimal PWA service worker: app-shell caching only (no offline API data —
// every screen here reads live, permission-guarded data, which must never
// be served stale from a cache). Registered by src/main.tsx, browser-only.
const CACHE_NAME = 'gadonghr-shell-v1'
const SHELL_ASSETS = ['/', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Never intercept API calls (svc-* origins/paths) or navigation to the
  // OIDC callback — only cache same-origin, GET, shell-asset-shaped
  // requests, so an access token is never at risk of being written into
  // the Cache Storage API.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
  )
})
