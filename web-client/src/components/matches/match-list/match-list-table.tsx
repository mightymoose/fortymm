import { Inbox } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { MatchListTableHead } from './match-list-table/match-list-table-head'
import { MatchListSkeletonRows } from './match-list-table/match-list-skeleton-rows'
import { MatchListRow, type MatchListRowView } from './match-list-table/match-list-row'
import type { NavigateFn } from './match-list-status'

export interface MatchListTableProps {
  /** Pre-projected row view models, ready to render. Empty array means the empty state (unless loading). */
  rows: MatchListRowView[]
  /** True while the first page is loading and there are no rows yet — render the skeleton. */
  isLoading: boolean
  /** Clears all filters from the empty state's button. */
  onClear: () => void
  navigate: NavigateFn
}

export const MatchListTable = ({
  rows,
  isLoading,
  onClear,
  navigate,
}: MatchListTableProps) => {
  if (isLoading && rows.length === 0) return <MatchListSkeletonRows />
  if (rows.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <Inbox size={56} strokeWidth={1.5} />
        </div>
        <div className="empty-title">No matches yet</div>
        <div className="empty-sub">
          Start a new match or clear the filters to see what's being played.
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="empty-clear"
          onClick={onClear}
        >
          Clear filters
        </Button>
      </div>
    )
  }
  return (
    <table className="matches">
      <MatchListTableHead />
      <tbody>
        {rows.map((row) => (
          <MatchListRow key={row.id} row={row} navigate={navigate} />
        ))}
      </tbody>
    </table>
  )
}
