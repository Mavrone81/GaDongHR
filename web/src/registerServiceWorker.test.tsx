import { describe, expect, it, vi } from 'vitest'
import { registerServiceWorker } from './registerServiceWorker'

// A minimal stand-in for `navigator.serviceWorker`. Real `EventTarget` (not
// a `vi.fn()` bag) so `dispatchEvent`/`addEventListener` behave exactly as
// they would in the browser — including firing every listener registered
// for a type, which matters for the "at most once" tests below.
class FakeServiceWorkerContainer extends EventTarget {
  controller: object | null = null
  register = vi.fn().mockResolvedValue(undefined)

  dispatchControllerChange(): void {
    this.dispatchEvent(new Event('controllerchange'))
  }
}

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size
    },
  }
}

describe('registerServiceWorker', () => {
  it('always registers /sw.js, regardless of whether the tab already has a controller', () => {
    const container = new FakeServiceWorkerContainer()
    registerServiceWorker(container, fakeStorage(), vi.fn())

    expect(container.register).toHaveBeenCalledOnce()
    expect(container.register).toHaveBeenCalledWith('/sw.js')
  })

  it('does nothing on a brand-new tab (no pre-existing controller): a controllerchange does not reload it', () => {
    // A page with no controller yet cannot be showing a stale cached shell
    // — there is nothing here for `clients.claim()`'s takeover to repair.
    // `clients.claim()` also fires `controllerchange` the very FIRST time
    // an uncontrolled page gets a controller, so skipping this case is
    // what stops every first-time visitor from getting one pointless reload.
    const container = new FakeServiceWorkerContainer()
    container.controller = null
    const reload = vi.fn()
    registerServiceWorker(container, fakeStorage(), reload)

    container.dispatchControllerChange()

    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads exactly once when an already-controlled (possibly poisoned-cache) tab is taken over by the new worker', () => {
    const container = new FakeServiceWorkerContainer()
    container.controller = {} // this tab was already controlled by some worker
    const reload = vi.fn()
    registerServiceWorker(container, fakeStorage(), reload)

    container.dispatchControllerChange()

    expect(reload).toHaveBeenCalledOnce()
  })

  it('THE reload-loop guard: firing controllerchange repeatedly in the same page instance still reloads at most once', () => {
    const container = new FakeServiceWorkerContainer()
    container.controller = {}
    const reload = vi.fn()
    registerServiceWorker(container, fakeStorage(), reload)

    container.dispatchControllerChange()
    container.dispatchControllerChange()
    container.dispatchControllerChange()
    container.dispatchControllerChange()
    container.dispatchControllerChange()

    expect(reload).toHaveBeenCalledOnce()
  })

  it('THE cross-reload guard: a fresh module instance (simulating the page after location.reload()) whose storage already has the flag set never reloads again', () => {
    // `location.reload()` re-executes this whole module from scratch, so
    // an in-memory flag would be wiped and re-armed on the next
    // `controllerchange` — this is what makes an infinite reload loop
    // possible, and the failure mode this test exists to rule out.
    // `sessionStorage` (faked here) is what survives the reload; this test
    // simulates the SECOND module instance seeing that persisted flag.
    const storage = fakeStorage({ 'gadonghr:sw-reloaded': '1' })
    const container = new FakeServiceWorkerContainer()
    container.controller = {}
    const reload = vi.fn()
    registerServiceWorker(container, storage, reload)

    container.dispatchControllerChange()

    expect(reload).not.toHaveBeenCalled()
  })
})
