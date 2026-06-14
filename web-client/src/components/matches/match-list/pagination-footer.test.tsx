import userEvent from '@testing-library/user-event'

import { paginationFooterPage } from './pagination-footer.page'

describe('PaginationFooter', () => {
  it('shows the range and total', () => {
    paginationFooterPage.render({ page: 1, total: 26, pageSize: 25 })

    expect(paginationFooterPage.getInfo()).toHaveTextContent(
      'Showing 1–25 of 26 matches',
    )
  })

  it('shows a 0 range when there are no matches', () => {
    paginationFooterPage.render({ page: 1, total: 0, pageSize: 25, totalPages: 1 })

    expect(paginationFooterPage.getInfo()).toHaveTextContent(
      'Showing 0–0 of 0 matches',
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
