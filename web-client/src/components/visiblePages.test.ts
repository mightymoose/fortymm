import { describe, expect, it } from 'vitest'
import { visiblePages } from './visiblePages'

describe('visiblePages', () => {
  it.each([
    [1, [1, 2, 3, 'gap', 12]],
    [2, [1, 2, 3, 'gap', 12]],
    [3, [1, 2, 3, 4, 'gap', 12]],
    [6, [1, 'gap', 5, 6, 7, 'gap', 12]],
    [10, [1, 'gap', 9, 10, 11, 12]],
    [11, [1, 'gap', 10, 11, 12]],
    [12, [1, 'gap', 10, 11, 12]],
  ])('shows page %i of 12 as %j', (page, slots) => {
    expect(visiblePages(page, 12)).toEqual(slots)
  })

  it('shows the page a one-page gap would stand for', () => {
    expect(visiblePages(4, 12)).toEqual([1, 2, 3, 4, 5, 'gap', 12])
    expect(visiblePages(9, 12)).toEqual([1, 'gap', 8, 9, 10, 11, 12])
  })

  it.each([
    [1, 1, [1]],
    [1, 2, [1, 2]],
    [2, 2, [1, 2]],
    [1, 3, [1, 2, 3]],
    [3, 3, [1, 2, 3]],
    [1, 4, [1, 2, 3, 4]],
    [1, 5, [1, 2, 3, 4, 5]],
    [3, 5, [1, 2, 3, 4, 5]],
    [5, 5, [1, 2, 3, 4, 5]],
  ])(
    'shows every page, with no gap, for page %i of %i',
    (page, pageCount, slots) => {
      expect(visiblePages(page, pageCount)).toEqual(slots)
    },
  )

  it('leaves a gap only where two or more pages are missing', () => {
    expect(visiblePages(1, 6)).toEqual([1, 2, 3, 'gap', 6])
    expect(visiblePages(3, 7)).toEqual([1, 2, 3, 4, 'gap', 7])
  })
})
