import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

import { RecentMatchRow, type RecentMatchRowProps } from './recent-match-row'
import { buildRecentMatchRowProps } from './recent-match-row.factory'

/** The route an opponent's name opens: that player's profile. Registered as a
 * stub in the harness so the typed `<Link>` resolves. */
export const PROFILE_ROUTE = '/players/$userId'

/** The `<tr>` an opponent's name sits in. Rows are told apart the way a reader
 * tells them apart — by who the match was against. */
const rowOf = (container: Container, opponent: string): HTMLElement => {
  const row = container.getByText(opponent).closest('tr')
  if (!row) throw new Error(`No match row for opponent "${opponent}"`)
  return row as HTMLElement
}

const cellsOf = (container: Container, opponent: string) =>
  within(rowOf(container, opponent)).getAllByRole('cell')

/** The Opponent cell — the first one. */
const opponentCellOf = (container: Container, opponent: string) =>
  cellsOf(container, opponent)[0]

const scoped = (container: Container) => ({
  /** One match's row, by opponent ("No opponent" for a solo match). */
  getRow(opponent: string) {
    return rowOf(container, opponent)
  },
  /** The router paints asynchronously, so a test starts here. */
  async findRow(opponent: string): Promise<HTMLElement> {
    await container.findByText(opponent)
    return rowOf(container, opponent)
  },
  queryRow(opponent: string): HTMLElement | null {
    const name = container.queryByText(opponent)
    return (name?.closest('tr') as HTMLElement | null) ?? null
  },
  /**
   * The opponent's name **as a link** to their profile — the row's one
   * navigation, and the thing the card used to withhold.
   *
   * `null` for a solo match, which has no player on the other side to link to.
   * Asked for by *role*, not by class or href: what matters is that the name is
   * a link at all — a `<span>` styled to look like one is still a dead end, and
   * an `<a>` with no `href` is not in the accessibility tree either.
   */
  queryOpponentLink(opponent: string): HTMLElement | null {
    return within(opponentCellOf(container, opponent)).queryByRole('link', {
      name: opponent,
    })
  },
  getOpponentLink(opponent: string): HTMLElement {
    return within(opponentCellOf(container, opponent)).getByRole('link', {
      name: opponent,
    })
  },
  /** Where that link points, e.g. `/players/p-9`. */
  getOpponentHref(opponent: string): string {
    return this.getOpponentLink(opponent).getAttribute('href') ?? ''
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
 *
 * The opponent's name is a typed `<Link>` to their profile, so the row mounts
 * under a memory router registering that route. The router resolves
 * **asynchronously**: start tests with `await recentMatchRowPage.findRow(…)`.
 *
 * Parent page objects (the card's display) spread `within(container)` to reuse
 * these accessors against every row at once.
 */
export const recentMatchRowPage = {
  render(overrides: Partial<RecentMatchRowProps> = {}) {
    const props = buildRecentMatchRowProps(overrides)
    renderWithRoutes(
      <table>
        <tbody>
          <RecentMatchRow {...props} />
        </tbody>
      </table>,
      { linkTargets: [PROFILE_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
