import { render, screen, within, type Container } from '@/test/utilities'

import { RecentMatchRow, type RecentMatchRowProps } from './recent-match-row'
import { buildRecentMatchRowProps } from './recent-match-row.factory'

/** The `<tr>` an opponent's name sits in. Rows are told apart the way a reader
 * tells them apart — by who the match was against. */
const rowOf = (container: Container, opponent: string): HTMLElement => {
  const row = container.getByText(opponent).closest('tr')
  if (!row) throw new Error(`No match row for opponent "${opponent}"`)
  return row as HTMLElement
}

const cellsOf = (container: Container, opponent: string) =>
  within(rowOf(container, opponent)).getAllByRole('cell')

const scoped = (container: Container) => ({
  /** One match's row, by opponent ("No opponent" for a solo match). */
  getRow(opponent: string) {
    return rowOf(container, opponent)
  },
  queryRow(opponent: string): HTMLElement | null {
    const name = container.queryByText(opponent)
    return (name?.closest('tr') as HTMLElement | null) ?? null
  },
  /**
   * The row's status dot. With the result chip gone this is the only place a
   * screen reader learns the match's state, so assert its **accessible name**
   * ("Won" / "Lost" / "Live" / "Awaiting acceptance" / "Up next" / "Voided") —
   * and its tone class for the colour.
   */
  getStatusDot(opponent: string) {
    const dot = rowOf(container, opponent).querySelector(
      '.recent-matches__dot',
    )
    if (!dot) throw new Error(`No status dot in the row for "${opponent}"`)
    return dot as HTMLElement
  },
  /** The score cell: per-game chips for a finished match, or the "Live" /
   * "Awaiting" / "—" text where a scoreline would go. */
  getScoreCell(opponent: string) {
    return cellsOf(container, opponent)[1]
  },
  /** The Δ cell. Reads `—` for any row that moved no rating — undecided *or*
   * unrated. Never "+0". */
  getDeltaCell(opponent: string) {
    return cellsOf(container, opponent)[2]
  },
  /** The "When" cell, e.g. "Mar 14". */
  getWhenCell(opponent: string) {
    return cellsOf(container, opponent)[3]
  },
})

/**
 * Test page-object for `RecentMatchRow` — one row of the Recent matches card.
 * The component renders a `<tr>`, so `render` supplies the surrounding table.
 * Parent page objects (the card's display) spread `within(container)` to reuse
 * these accessors against every row at once.
 */
export const recentMatchRowPage = {
  render(overrides: Partial<RecentMatchRowProps> = {}) {
    const props = buildRecentMatchRowProps(overrides)
    render(
      <table>
        <tbody>
          <RecentMatchRow {...props} />
        </tbody>
      </table>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
