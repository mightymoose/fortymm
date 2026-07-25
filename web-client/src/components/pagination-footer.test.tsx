import userEvent from '@testing-library/user-event'

import { paginationFooterPage } from './pagination-footer.page'

describe('PaginationFooter', () => {
  it('shows the range and total', () => {
    paginationFooterPage.render({ page: 1, total: 26, pageSize: 25 })

    expect(paginationFooterPage.getInfo()).toHaveTextContent(
      'Showing 1–25 of 26 matches',
    )
  })

  it('inflects the noun to the singular at a count of 1', () => {
    paginationFooterPage.render({ total: 1, pageSize: 25, totalPages: 1 })

    const info = paginationFooterPage.getInfo()
    // "of 1 matches" is ungrammatical — a lone result reads the singular.
    expect(info).toHaveTextContent('Showing 1–1 of 1 match')
    // Discriminating: "of 1 match" is a substring of the ungrammatical "of 1
    // matches", so the positive check alone stays green against the old
    // fixed-plural code. Assert the plural is absent so a regression reds.
    expect(info).not.toHaveTextContent(/of 1 matches/)
  })

  it('keeps the plural noun for a count above 1', () => {
    paginationFooterPage.render({ total: 2, pageSize: 25, totalPages: 1 })

    expect(paginationFooterPage.getInfo()).toHaveTextContent(
      'Showing 1–2 of 2 matches',
    )
  })

  it('renders an in-range page range correctly', () => {
    // Page 2 of 4, 100 results, 25/page => Showing 26–50.
    paginationFooterPage.render({
      page: 2,
      total: 100,
      pageSize: 25,
      totalPages: 4,
    })

    expect(paginationFooterPage.getInfo()).toHaveTextContent(
      'Showing 26–50 of 100 matches',
    )
  })

  it('clamps an out-of-range page to the last page range (start <= end)', () => {
    // A deep-linked ?page=999 against a 25-result list (1 page) must not render
    // "Showing 24951–25000 of 25" — the footer clamps to the last valid page.
    paginationFooterPage.render({
      page: 999,
      total: 25,
      pageSize: 25,
      totalPages: 1,
    })

    expect(paginationFooterPage.getInfo()).toHaveTextContent(
      'Showing 1–25 of 25 matches',
    )
  })

  it('shows a 0 range when there are no matches', () => {
    paginationFooterPage.render({ page: 1, total: 0, pageSize: 25, totalPages: 1 })

    expect(paginationFooterPage.getInfo()).toHaveTextContent(
      'Showing 0–0 of 0 matches',
    )
  })

  it('offers no page link when there are no matches', () => {
    // Callers clamp their page count with `Math.max(1, …)`, so an empty list
    // arrives here as `totalPages: 1` — and used to render a live page-`1`
    // anchor beside "of 0 matches", pointing at a page that does not exist
    // (#889). Zero results, zero pages to click.
    paginationFooterPage.render({ page: 1, total: 0, pageSize: 25, totalPages: 1 })

    expect(paginationFooterPage.queryPageLink(1)).not.toBeInTheDocument()
    expect(paginationFooterPage.queryPageLinks()).toHaveLength(0)
  })

  it('hides the pager entirely when there are no matches', () => {
    paginationFooterPage.render({ page: 1, total: 0, pageSize: 25, totalPages: 1 })

    expect(paginationFooterPage.queryPager()).not.toBeInTheDocument()
  })

  it('still shows the page token for a single page of results', () => {
    // The guard keys off "no results", not "one page" — a 3-player list is a
    // legitimate single-page list and keeps its (active) page-1 token.
    paginationFooterPage.render({ page: 1, total: 3, pageSize: 25, totalPages: 1 })

    expect(paginationFooterPage.getPageLink(1)).toBeInTheDocument()
    expect(paginationFooterPage.getPageLink(1)).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('disables First and Previous on page 1', () => {
    paginationFooterPage.render({ page: 1, totalPages: 3 })

    expect(paginationFooterPage.getFirstPageButton()).toBeDisabled()
    expect(paginationFooterPage.getPrevPageButton()).toBeDisabled()
    expect(paginationFooterPage.getNextPageButton()).toBeEnabled()
    expect(paginationFooterPage.getLastPageButton()).toBeEnabled()
  })

  it('disables Next and Last on the last page', () => {
    paginationFooterPage.render({ page: 3, totalPages: 3 })

    expect(paginationFooterPage.getNextPageButton()).toBeDisabled()
    expect(paginationFooterPage.getLastPageButton()).toBeDisabled()
    expect(paginationFooterPage.getFirstPageButton()).toBeEnabled()
    expect(paginationFooterPage.getPrevPageButton()).toBeEnabled()
  })

  it('pages to first, previous, next, and last via the chevron buttons', async () => {
    const setPage = vi.fn()
    paginationFooterPage.render({ page: 2, setPage, totalPages: 4 })

    const user = userEvent.setup()
    await user.click(paginationFooterPage.getFirstPageButton())
    await user.click(paginationFooterPage.getPrevPageButton())
    await user.click(paginationFooterPage.getNextPageButton())
    await user.click(paginationFooterPage.getLastPageButton())

    expect(setPage).toHaveBeenNthCalledWith(1, 1)
    expect(setPage).toHaveBeenNthCalledWith(2, 1)
    expect(setPage).toHaveBeenNthCalledWith(3, 3)
    expect(setPage).toHaveBeenNthCalledWith(4, 4)
  })

  it('renders the numbered page links and pages to a clicked number', async () => {
    const setPage = vi.fn()
    paginationFooterPage.render({ page: 1, setPage, totalPages: 3 })

    // paginationRange(1, 3) => [1, 2, 3]
    expect(paginationFooterPage.getPageLink(1)).toBeInTheDocument()
    expect(paginationFooterPage.getPageLink(2)).toBeInTheDocument()
    expect(paginationFooterPage.getPageLink(3)).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(paginationFooterPage.getPageLink(2))

    expect(setPage).toHaveBeenCalledWith(2)
  })

  it('marks the current page link active', () => {
    paginationFooterPage.render({ page: 2, totalPages: 3 })

    expect(paginationFooterPage.getPageLink(2)).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(paginationFooterPage.getPageLink(1)).not.toHaveAttribute('aria-current')
  })
})
