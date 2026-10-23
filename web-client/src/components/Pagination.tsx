import { useState } from 'react'
import { visiblePages } from './visiblePages'

// A row of page buttons between Previous and Next buttons, for a long list
// shown a page at a time. Styled by `.pagination` in styles/base.css. It's
// a navigation landmark named Pagination. The current page's button has
// aria-current. A gap stands for the pages left out (see visiblePages()),
// and is hidden from assistive tech, which reads the pages' numbers.
//
// Previous is disabled on the first page and Next on the last, with
// aria-disabled rather than the disabled attribute: a disabled button
// would drop the focus of someone paging through with the keyboard.
//
// It's uncontrolled: `defaultPage` sets the current page, the first unless
// given, and onPageChange hears of each move.
export function Pagination({
  pageCount,
  defaultPage = 1,
  onPageChange,
}: {
  pageCount: number
  defaultPage?: number
  onPageChange?: (page: number) => void
}) {
  const [page, setPage] = useState(defaultPage)

  function goTo(next: number) {
    if (next < 1 || next > pageCount || next === page) return
    setPage(next)
    onPageChange?.(next)
  }

  return (
    <nav aria-label="Pagination" className="pagination">
      <button
        type="button"
        aria-label="Previous page"
        aria-disabled={page === 1}
        className="pagination-item"
        onClick={() => goTo(page - 1)}
      >
        ‹
      </button>
      {visiblePages(page, pageCount).map((slot, index) =>
        slot === 'gap' ? (
          <span
            key={`gap-${index}`}
            className="pagination-item pagination-gap"
            aria-hidden="true"
          >
            …
          </span>
        ) : (
          <button
            key={slot}
            type="button"
            aria-label={`Page ${slot}`}
            aria-current={slot === page ? 'page' : undefined}
            className="pagination-item"
            onClick={() => goTo(slot)}
          >
            {slot}
          </button>
        ),
      )}
      <button
        type="button"
        aria-label="Next page"
        aria-disabled={page === pageCount}
        className="pagination-item"
        onClick={() => goTo(page + 1)}
      >
        ›
      </button>
    </nav>
  )
}
