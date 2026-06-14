import type { PaginationFooterProps } from './pagination-footer'

/** Page 1 of 2, 26 results — Next enabled, Prev/First disabled. */
export function buildPaginationFooterProps(
  overrides: Partial<PaginationFooterProps> = {},
): PaginationFooterProps {
  return {
    page: 1,
    setPage: vi.fn(),
    total: 26,
    pageSize: 25,
    totalPages: 2,
    ...overrides,
  }
}
