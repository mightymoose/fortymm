import { vi } from 'vitest'

import { type MatchListTableProps } from './match-list-table'
import { buildMatchListRowView } from './match-list-table/match-list-row.factory'
import type { NavigateFn } from './match-list-status'

/**
 * Props for `MatchListTable` — a settled table with one viewer-won row.
 *
 * Drive the other two states by overriding `rows`:
 * - `{ isLoading: true, rows: [] }` renders the loading skeleton.
 * - `{ isLoading: false, rows: [] }` renders the empty state.
 */
export function buildMatchListTableProps(
  overrides: Partial<MatchListTableProps> = {},
): MatchListTableProps {
  return {
    rows: [buildMatchListRowView()],
    isLoading: false,
    isAttention: false,
    query: '',
    onClear: vi.fn(),
    onClearSearch: vi.fn(),
    navigate: vi.fn() as unknown as NavigateFn,
    ...overrides,
  }
}
