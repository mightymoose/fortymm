import { CheckCircle2, Inbox, SearchX } from 'lucide-react'

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
  /** True when the Attention tab is active — swaps in the attention-flavored empty states. */
  isAttention: boolean
  /** The active (trimmed) search term, used to phrase the no-results state. */
  query: string
  /**
   * Whether a search, a non-"all" status tab, or an out-of-range page is
   * narrowing the list. Drives the cold-start vs filtered empty copy when there
   * is no search term: a filtered no-result reads "No matches match your
   * filters" and offers a Clear filters button (the user has matches, just not
   * here), while a genuinely empty list reads "No matches yet" — a first-run
   * cold start where clearing filters is a no-op, so the button is omitted.
   * Without this, a status-tab/out-of-range no-result view falsely implies the
   * user has never played (#373).
   */
  isFiltered: boolean
  /** Clears all filters (used by "Clear filters" / "View all matches"). */
  onClear: () => void
  /** Clears only the search term, staying on the active tab. */
  onClearSearch: () => void
  navigate: NavigateFn
}

export const MatchListTable = ({
  rows,
  isLoading,
  isAttention,
  query,
  isFiltered,
  onClear,
  onClearSearch,
  navigate,
}: MatchListTableProps) => {
  if (isLoading && rows.length === 0) return <MatchListSkeletonRows />
  if (rows.length === 0) {
    return (
      <EmptyState
        isAttention={isAttention}
        query={query}
        isFiltered={isFiltered}
        onClear={onClear}
        onClearSearch={onClearSearch}
      />
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

function EmptyState({
  isAttention,
  query,
  isFiltered,
  onClear,
  onClearSearch,
}: {
  isAttention: boolean
  query: string
  isFiltered: boolean
  onClear: () => void
  onClearSearch: () => void
}) {
  // A search that filtered everything out reads the same on either tab: tell the
  // user what they searched for and offer to clear just the search.
  if (query) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <SearchX size={56} strokeWidth={1.5} />
        </div>
        <div className="empty-title">
          {isAttention
            ? `No attention matches for “${query}”.`
            : `No matches for “${query}”.`}
        </div>
        <div className="empty-sub">Try a different name or clear the search.</div>
        <Button
          variant="ghost"
          size="sm"
          className="empty-clear"
          onClick={onClearSearch}
        >
          Clear search
        </Button>
      </div>
    )
  }
  // Attention with no search and nothing pending: the calm "all caught up"
  // state, with a way back to the full list (PRD §"Empty States").
  if (isAttention) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <CheckCircle2 size={56} strokeWidth={1.5} />
        </div>
        <div className="empty-title">You&rsquo;re all caught up.</div>
        <div className="empty-sub">
          No matches need your attention right now.
        </div>
        <Button variant="ghost" size="sm" className="empty-clear" onClick={onClear}>
          View all matches
        </Button>
      </div>
    )
  }
  // No search term, not the attention tab. A non-"all" status tab or an
  // out-of-range page can still have narrowed the list to nothing (#373): say
  // so and offer Clear filters. A genuinely empty list is a first-run cold
  // start — clearing filters is a no-op, so the button is omitted.
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={56} strokeWidth={1.5} />
      </div>
      <div className="empty-title">
        {isFiltered ? 'No matches match your filters' : 'No matches yet'}
      </div>
      <div className="empty-sub">
        {isFiltered
          ? 'Try a different search or clear the filters to see what’s being played.'
          : 'Start a new match to see what’s being played.'}
      </div>
      {isFiltered && (
        <Button
          variant="ghost"
          size="sm"
          className="empty-clear"
          onClick={onClear}
        >
          Clear filters
        </Button>
      )}
    </div>
  )
}
