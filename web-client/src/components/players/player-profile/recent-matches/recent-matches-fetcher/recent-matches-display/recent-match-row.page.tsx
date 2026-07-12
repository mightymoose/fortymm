import {
  MATCH_DETAIL_ROUTE,
  matchRowLinkPage,
} from '@/components/matches/match-row-link/match-row-link.page'
import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

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
  /** The same row, awaited — the harness mounts a router, which resolves
   * asynchronously, so a test's first query has to be a `find…`. */
  async findRow(opponent: string) {
    await container.findByText(opponent)
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
  /** The "When" cell, e.g. "Mar 14". It holds the row's link. */
  getWhenCell(opponent: string) {
    return cellsOf(container, opponent)[3]
  },
  /**
   * The row's link to its match — a real `<a href="/matches/<id>">`, stretched
   * across the row (#989). Located inside the row, by role: assert its `href`,
   * because "a link exists" was never the claim.
   *
   * There is exactly **one** per row, hence the bare `getByRole('link')` — if a
   * second anchor ever creeps into a row, this throws, which is the point.
   */
  getDetailLink(opponent: string) {
    return within(rowOf(container, opponent)).getByRole('link')
  },
  /** Every link in the row — one, always. A stretched anchor a screen reader
   * hears four times is precisely the failure mode this design avoids. */
  getRowLinks(opponent: string) {
    return within(rowOf(container, opponent)).queryAllByRole('link')
  },
  /** The link's accessors from its own page object (`getMatchLink(ariaLabel)`),
   * scoped to this container — the link's contract stays pinned by its tests. */
  ...matchRowLinkPage.within(container),
})

/**
 * Test page-object for `RecentMatchRow` — one row of the Recent matches card.
 *
 * The component renders a `<tr>`, so `render` supplies the surrounding table —
 * and, since the "When" cell is now a typed `<Link>` to the match (#989), a
 * memory router registering `/matches/$matchId` for it to resolve against. The
 * router resolves asynchronously, so tests start with an `await findRow(…)`.
 *
 * Parent page objects (the card's display) spread `within(container)` to reuse
 * these accessors against every row at once.
 */
export const recentMatchRowPage = {
  render(overrides: Partial<RecentMatchRowProps> = {}) {
    const props = buildRecentMatchRowProps(overrides)
    return renderWithRoutes(
      <table>
        <tbody>
          <RecentMatchRow {...props} />
        </tbody>
      </table>,
      { linkTargets: [MATCH_DETAIL_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
