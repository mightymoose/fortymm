import { vi } from 'vitest'

import { type MatchListTableProps } from './match-list-table'
import { buildMatchListRowView } from './match-list-table/match-list-row.factory'
import type { NavigateFn } from './match-list-status'

/**
 * Props for `MatchListTable` — a settled table with one viewer-won row.
 *
 * Drive the other states by overriding `rows` / `isFiltered`:
 * - `{ isLoading: true, rows: [] }` renders the loading skeleton.
 * - `{ isLoading: false, rows: [] }` renders the unfiltered cold-start empty.
 * - `{ isLoading: false, rows: [], isFiltered: true }` renders the filtered
 *   no-result empty ("No matches match your filters").
 */
export function buildMatchListTableProps(
  overrides: Partial<MatchListTableProps> = {},
): MatchListTableProps {
  return {
    rows: [buildMatchListRowView()],
    isLoading: false,
    isFiltered: false,
    onClear: vi.fn(),
    navigate: vi.fn() as unknown as NavigateFn,
    ...overrides,
  }
}
