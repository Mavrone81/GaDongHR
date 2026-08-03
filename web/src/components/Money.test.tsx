import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Money } from './Money'
import { renderWithProviders } from '../test/testUtils'

/**
 * "Assert a bigint satang value formats correctly, proving no float path"
 * (task brief). `123456n` satang is ฿1,234.56 — a value a `number` (IEEE
 * double) can represent exactly, chosen so a hypothetical float
 * implementation would not obviously diverge; the point of this test is
 * the `bigint` type at the boundary (Money's prop is `satang: bigint`,
 * making `Money satang={1234.56}` a compile error, not a runtime bug), not
 * a rounding edge case — `@gadong/kernel`'s own `formatTHB` suite already
 * covers those.
 */
describe('Money renders bigint satang via the kernel formatter', () => {
  it('renders 123456n satang as ฿1,234.56', () => {
    renderWithProviders(<Money satang={123456n} />)
    expect(screen.getByText('฿1,234.56')).toBeInTheDocument()
  })

  it('renders a negative bigint with a leading sign', () => {
    renderWithProviders(<Money satang={-500n} />)
    expect(screen.getByText('-฿5.00')).toBeInTheDocument()
  })
})
