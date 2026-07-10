import { within } from '@/test/utilities'

import { ROWS } from './recent-results-card-skeleton'
import { recentResultsCardSkeletonPage } from './recent-results-card-skeleton.page'

describe('RecentResultsCardSkeleton', () => {
  it('announces the load through a busy status region', () => {
    recentResultsCardSkeletonPage.render()

    expect(recentResultsCardSkeletonPage.getStatus()).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })

  // The rebuild mirrors the loaded card's real <table> instead of a hand-copied
  // flex approximation, so column widths derive from the shared layout (#863).
  // The old flex-only skeleton had no table/thead at all — these fail on it.
  it('mirrors the loaded card with a real table and shimmered header band', () => {
    recentResultsCardSkeletonPage.render()

    const table = recentResultsCardSkeletonPage.getTable()
    expect(table.tagName).toBe('TABLE')
    expect(table.querySelector('thead')).not.toBeNull()
  })

  it('renders one placeholder row per reserved result', () => {
    recentResultsCardSkeletonPage.render()

    expect(recentResultsCardSkeletonPage.getRows()).toHaveLength(ROWS)
  })

  // The name shimmer now lives inside the collapsing cell (maxWidth:0;
  // width:100%) so its width is derived from the table, not a hand-set
  // maxWidth. And each row carries the win/loss dot the loaded row renders,
  // which the old skeleton dropped (the ~16px avatar shift). The old flex
  // skeleton had neither a collapsing cell nor a dot, so both fail on it.
  it('gives each row a collapsing opponent cell containing a dot placeholder', () => {
    recentResultsCardSkeletonPage.render()

    const cells = recentResultsCardSkeletonPage.getOpponentCells()
    expect(cells).toHaveLength(ROWS)

    for (const cell of cells) {
      expect(cell.tagName).toBe('TD')
      expect(cell).toHaveStyle({ maxWidth: '0px', width: '100%' })
      // The win/loss dot placeholder the loaded row renders. `getByTestId`
      // (singular) also fails if a row somehow renders more than one dot.
      expect(within(cell).getByTestId('dashboard-recent-results-skeleton-dot')).toBeInTheDocument()
    }
  })
})
