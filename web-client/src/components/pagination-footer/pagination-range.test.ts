import { paginationRange, type PageToken } from './pagination-range'

describe('paginationRange', () => {
  it('returns just the first page when there is a single page', () => {
    expect(paginationRange(1, 1)).toEqual<PageToken[]>([1])
  })

  it('lists every page with no ellipsis when the total is small', () => {
    expect(paginationRange(2, 3)).toEqual<PageToken[]>([1, 2, 3])
  })

  it('brackets the current page with ellipses when it sits in the middle of a large total', () => {
    expect(paginationRange(5, 10)).toEqual<PageToken[]>([
      1,
      'ellipsis',
      4,
      5,
      6,
      'ellipsis',
      10,
    ])
  })

  it('collapses the near (left) ellipsis at the left edge', () => {
    // current near the start: left guard (left > 2) is false, so no leading ellipsis
    expect(paginationRange(2, 10)).toEqual<PageToken[]>([1, 2, 3, 'ellipsis', 10])
  })

  it('collapses the near (right) ellipsis at the right edge', () => {
    // current near the end: right guard (right < total - 1) is false, so no trailing ellipsis
    expect(paginationRange(9, 10)).toEqual<PageToken[]>([1, 'ellipsis', 8, 9, 10])
  })
})
