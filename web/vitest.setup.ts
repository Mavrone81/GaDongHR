import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// `test.globals: false` (vite.config.ts) means Testing Library's own
// auto-cleanup detection (which looks for a global `afterEach`) never
// fires — without this, every render() across a test file accumulates in
// the same jsdom document, and a later `getByRole` sees every previous
// test's elements too. Explicit is better than flipping `globals: true`
// repo-wide just to get an implicit afterEach.
afterEach(() => {
  cleanup()
})
