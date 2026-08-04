import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

// `public/sw.js` is a real browser Service Worker script: `self`, `caches`,
// `clients` and `addEventListener` are globals of a Worker's own scope, not
// something this file can `import`. There is no existing harness for that
// (`web/public/**` is deliberately excluded from lint/typecheck — see
// `eslint.config.js` — precisely because it's a browser-served artifact,
// not a TS module). Rather than skip testing it, we evaluate its real
// source inside an isolated `vm` context that stands in for the Worker
// global scope, capturing whatever handlers it registers via
// `addEventListener` so tests can fire `install`/`activate` events at it
// exactly as the browser would, then assert against a fake `CacheStorage`
// that behaves like the real one (named buckets of request -> response)
// rather than a bag of `vi.fn()` mocks — so "the old cache's `/` entry is
// gone" is something we can actually observe, not just infer from a call
// count.
// Built with `node:path`, not `new URL('../../public/sw.js', import.meta.url)`
// — under this project's `jsdom` test environment, the global `URL`
// constructor is jsdom's own polyfill, which does not resolve a relative
// path against a `file:` base correctly (it silently falls back to
// jsdom's default document location, `http://localhost:3000/`). Plain
// path arithmetic on the already-valid `file://` path from
// `fileURLToPath(import.meta.url)` sidesteps that entirely.
const SW_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/sw.js')
const SW_SOURCE = readFileSync(SW_PATH, 'utf8')

type FakeResponse = { body: string }

function fakeCacheStorage() {
  const store = new Map<string, Map<string, FakeResponse>>()
  function bucket(name: string): Map<string, FakeResponse> {
    let b = store.get(name)
    if (!b) {
      b = new Map()
      store.set(name, b)
    }
    return b
  }
  return {
    async open(name: string) {
      const b = bucket(name)
      return {
        async put(request: string, response: FakeResponse) {
          b.set(request, response)
        },
        async addAll(urls: string[]) {
          for (const url of urls) b.set(url, { body: `shell:${url}` })
        },
      }
    },
    async keys() {
      return Array.from(store.keys())
    },
    async delete(name: string) {
      return store.delete(name)
    },
    async match(request: string) {
      for (const b of store.values()) {
        if (b.has(request)) return b.get(request)
      }
      return undefined
    },
  }
}

interface LoadedWorker {
  listeners: Record<string, (event: { waitUntil: (p: Promise<unknown>) => void }) => void>
  skipWaiting: ReturnType<typeof vi.fn>
  clientsClaim: ReturnType<typeof vi.fn>
}

function loadServiceWorker(caches: ReturnType<typeof fakeCacheStorage>): LoadedWorker {
  const listeners: LoadedWorker['listeners'] = {}
  const skipWaiting = vi.fn()
  const clientsClaim = vi.fn().mockResolvedValue(undefined)

  const sandbox = {
    self: {
      addEventListener: (type: string, handler: LoadedWorker['listeners'][string]) => {
        listeners[type] = handler
      },
      skipWaiting,
      clients: { claim: clientsClaim },
      location: { origin: 'https://gadonghr.example' },
    },
    caches,
    // Referenced by the `fetch` handler, which none of these tests
    // exercise, but the script must still evaluate without a ReferenceError.
    fetch: vi.fn(),
    Response: { error: vi.fn() },
    URL,
  }
  vm.createContext(sandbox)
  vm.runInContext(SW_SOURCE, sandbox, { filename: SW_PATH })
  return { listeners, skipWaiting, clientsClaim }
}

// Runs the handler exactly as the browser would: call it with a fake
// event, then await whatever it passed to `event.waitUntil` — the handler
// itself returns `undefined`, all the real work happens inside that promise.
async function fire(worker: LoadedWorker, type: string): Promise<void> {
  const handler = worker.listeners[type]
  if (!handler) throw new Error(`sw.js registered no '${type}' listener`)
  let waited: Promise<unknown> = Promise.resolve()
  handler({
    waitUntil: (p) => {
      waited = p
    },
  })
  await waited
}

describe('public/sw.js', () => {
  it('install: calls self.skipWaiting() so the corrected worker does not wait for every open tab to close', async () => {
    const worker = loadServiceWorker(fakeCacheStorage())

    await fire(worker, 'install')

    expect(worker.skipWaiting).toHaveBeenCalledOnce()
  })

  it('activate: calls self.clients.claim() so the corrected worker takes control of already-open tabs', async () => {
    const worker = loadServiceWorker(fakeCacheStorage())

    await fire(worker, 'activate')

    expect(worker.clientsClaim).toHaveBeenCalledOnce()
  })

  it('activate: deletes every cache that is not the current CACHE_NAME, including the old `/` navigation entry', async () => {
    const caches = fakeCacheStorage()
    // Simulate a browser that registered the OLD (v1, cache-first) worker
    // before commit 7ee945b: it has a `gadonghr-shell-v1` cache holding
    // the poisoned `/` response pointing at deleted asset hashes — the
    // exact entry that made the app render blank.
    const v1 = await caches.open('gadonghr-shell-v1')
    await v1.put('/', { body: '<html>stale shell, dead asset hashes</html>' })
    const worker = loadServiceWorker(caches)

    await fire(worker, 'activate')

    expect(await caches.keys()).not.toContain('gadonghr-shell-v1')
    expect(await caches.match('/')).toBeUndefined()
  })

  it('activate: leaves the current CACHE_NAME cache alone', async () => {
    const caches = fakeCacheStorage()
    const current = await caches.open('gadonghr-shell-v2')
    await current.put('/', { body: '<html>current shell</html>' })
    const worker = loadServiceWorker(caches)

    await fire(worker, 'activate')

    expect(await caches.keys()).toContain('gadonghr-shell-v2')
    expect(await caches.match('/')).toEqual({ body: '<html>current shell</html>' })
  })
})
