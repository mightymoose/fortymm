import { render, screen, type Container } from '@/test/utilities'

import { PaginationFooter, type PaginationFooterProps } from './pagination-footer'
import { buildPaginationFooterProps } from './pagination-footer.factory'

const scoped = (container: Container) => ({
  /** The "Showing {first}–{last} of {total} {noun}" range line. */
  getInfo() {
    return container.getByText(/showing/i)
  },
  /** The «First page» chevron button — disabled on page 1. */
  getFirstPageButton() {
    return container.getByRole('button', { name: /first page/i })
  },
  /** The «Previous page» chevron button — disabled on page 1. */
  getPrevPageButton() {
    return container.getByRole('button', { name: /previous page/i })
  },
  /** The «Next page» chevron button — disabled on the last page. */
  getNextPageButton() {
    return container.getByRole('button', { name: /next page/i })
  },
  /** The «Last page» chevron button — disabled on the last page. */
  getLastPageButton() {
    return container.getByRole('button', { name: /last page/i })
  },
  /**
   * The numbered page link for `n` — PaginationLink renders an `<a href="#">`,
   * so it resolves as a `link` whose accessible name is the page number.
   */
  getPageLink(n: number) {
    return container.getByRole('link', { name: String(n) })
  },
  queryPageLink(n: number) {
    return container.queryByRole('link', { name: String(n) })
  },
  /**
   * Every clickable page token, whatever its number. Use this to assert the
   * *absence* of a pager: an empty list must offer no page to click (#889).
   */
  queryPageLinks() {
    return container.queryAllByRole('link')
  },
  /** The pager itself — `Pagination` renders `<nav aria-label="pagination">`. */
  queryPager() {
    return container.queryByRole('navigation', { name: /pagination/i })
  },
})

/**
 * Test page-object for `PaginationFooter` — the table's range readout and the
 * first/prev/numbered/next/last pager. The numbered links are plain
 * `<a href="#">` anchors (not TanStack `<Link>`s), so no memory-router harness
 * is needed — a plain `render()` suffices and tests read synchronously.
 */
export const paginationFooterPage = {
  render(overrides: Partial<PaginationFooterProps> = {}) {
    const props = buildPaginationFooterProps(overrides)
    render(<PaginationFooter {...props} />)
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed the footer spread this to
   * expose the same queries as their own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
