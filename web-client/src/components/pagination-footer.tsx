import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from '@/components/ui/pagination'

import { paginationRange } from './pagination-footer/pagination-range'

export interface PaginationFooterProps {
  page: number
  setPage: (n: number) => void
  total: number
  pageSize: number
  totalPages: number
  /**
   * What the readout counts — "…of 26 **matches**", "…of 40 **players**".
   * Required on purpose: this footer is shared across pages, and a default
   * would let a new caller silently ship someone else's copy.
   */
  noun: string
}

/**
 * The list-page pagination footer: a "Showing 1–25 of 26 {noun}" readout plus
 * the first/prev/numbered/next/last pager. Shared by `/matches`, `/players`,
 * and the player match-history page.
 *
 * It renders the `.footer` / `.footer-info` / `.mono` class names but imports
 * no CSS of its own — each consuming page's stylesheet supplies them.
 */
export const PaginationFooter = ({
  page,
  setPage,
  total,
  pageSize,
  totalPages,
  noun,
}: PaginationFooterProps) => {
  // Clamp a stale/out-of-range `page` to a valid one so the range math can
  // never render start > end — e.g. the frame before the parent's redirect
  // effect snaps a deep-linked `?page=999` back to the last page (#637). The
  // footer is self-protecting regardless of what the caller passes.
  const safePage = Math.min(Math.max(1, page), totalPages)
  const first = total === 0 ? 0 : (safePage - 1) * pageSize + 1
  const last = Math.min(total, safePage * pageSize)
  const tokens = paginationRange(safePage, totalPages)
  const atFirst = safePage <= 1
  const atLast = safePage >= totalPages

  // No results means there is no page to go to, so the pager is suppressed
  // entirely and the footer is just its "Showing 0–0 of 0 {noun}" readout
  // (#889). The guard has to live here rather than in `paginationRange`: every
  // caller clamps its page count with `Math.max(1, …)`, so the range helper is
  // handed `totalPages: 1` and never sees the zero. `total` — the true result
  // count, the one the readout prints — is the only thing that tells "no
  // results" apart from a legitimate single-page list, which still gets its
  // page-1 token.
  const isEmpty = total === 0

  return (
    <div className="footer">
      <div className="footer-info">
        Showing <span className="mono">{first}–{last}</span> of{' '}
        <span className="mono">{total}</span> {noun}
      </div>
      <div className="footer-spacer" />
      {!isEmpty && (
        <Pagination className="mx-0 w-auto justify-end">
          <PaginationContent>
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={atFirst}
                onClick={() => setPage(1)}
                aria-label="First page"
              >
                <ChevronsLeft size={14} strokeWidth={2.4} />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={atFirst}
                onClick={() => setPage(safePage - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={14} strokeWidth={2.4} />
              </Button>
            </PaginationItem>
            {tokens.map((t, i) =>
              t === 'ellipsis' ? (
                <PaginationItem key={i}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={i}>
                  <PaginationLink
                    href="#"
                    isActive={t === safePage}
                    onClick={(e) => {
                      e.preventDefault()
                      setPage(t)
                    }}
                  >
                    {t}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={atLast}
                onClick={() => setPage(safePage + 1)}
                aria-label="Next page"
              >
                <ChevronRight size={14} strokeWidth={2.4} />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={atLast}
                onClick={() => setPage(totalPages)}
                aria-label="Last page"
              >
                <ChevronsRight size={14} strokeWidth={2.4} />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  )
}
