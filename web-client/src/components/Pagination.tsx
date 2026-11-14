import { useState } from 'react'
import './Pagination.css'

// The design system's pagination (.fm-pages): a button per page of a long
// list, named "Page 2"; the page shown is aria-current="page", on
// --accent-soft. Choosing a page shows it as current and tells `onChange`.
export function Pagination({
  label,
  pages,
  defaultPage = 1,
  onChange,
}: {
  label: string
  pages: number
  defaultPage?: number
  onChange?: (page: number) => void
}) {
  const [current, setCurrent] = useState(defaultPage)

  function choose(page: number) {
    setCurrent(page)
    onChange?.(page)
  }

  return (
    <nav aria-label={label} className="pagination">
      {Array.from({ length: pages }, (_, index) => index + 1).map((page) => (
        <button
          key={page}
          type="button"
          aria-label={`Page ${page}`}
          aria-current={page === current ? 'page' : undefined}
          onClick={() => choose(page)}
        >
          {page}
        </button>
      ))}
    </nav>
  )
}
