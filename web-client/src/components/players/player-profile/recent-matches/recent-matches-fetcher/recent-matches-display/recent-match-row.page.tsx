import {
  MATCH_DETAIL_ROUTE,
  matchRowLinkPage,
} from '@/components/matches/match-row-link/match-row-link.page'
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

/** The "When" cell — the last one. It holds the row's link to its match. */
const whenCellOf = (container: Container, opponent: string) =>
  cellsOf(container, opponent)[3]

const scoped = (container: Container) => ({
  /** One match's row, by opponent ("No opponent" for a solo match). */
  getRow(opponent: string) {
    return rowOf(container, opponent)
  },
  /** The same row, awaited — the harness mounts a router (both the opponent's
   * name and the date cell are typed `<Link>`s) and it resolves asynchronously,
   * so a test's first query has to be a `find…`. */
  async findRow(opponent: string): Promise<HTMLElement> {
    await container.findByText(opponent)
    return rowOf(container, opponent)
  },
  queryRow(opponent: string): HTMLElement | null {
    const name = container.queryByText(opponent)
    return (name?.closest('tr') as HTMLElement | null) ?? null
  },
  /**
   * The opponent's name **as a link** to their profile — the thing the card used
   * to withhold (#1005).
   *
   * `null` for a solo match, which has no player on the other side to link to.
   * Asked for by *role*, not by class or href: what matters is that the name is
   * a link at all — a `<span>` styled to look like one is still a dead end, and
   * an `<a>` with no `href` is not in the accessibility tree either.
   *
   * Scoped to the Opponent cell and named for the *person*, so it can never
   * accidentally match the row's other link — the stretched anchor to the match,
   * which sits in the "When" cell and is named for the *match*.
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
  /** The Δ cell. Reads `—` for any row that moved no rating — undecided,
   * unrated, or a rating just established. Never "+0". The em-dash cell still
   * carries a truthful accessible name naming which of those it is, so read the
   * `role="img"` inside it for that. */
  getDeltaCell(opponent: string) {
    return cellsOf(container, opponent)[2]
  },
  /** The "When" cell, e.g. "Mar 14". It holds the row's link to the match. */
  getWhenCell(opponent: string) {
    return whenCellOf(container, opponent)
  },
  /**
   * The row's link to its match — a real `<a href="/matches/<id>">`, stretched
   * across the row (#989). Assert its **href**: "a link exists" was never the
   * claim.
   *
   * Scoped to the **"When" cell**, not to the whole row. A row holds two links
   * now, and this is the one on the date. (It was a bare row-wide
   * `getByRole('link')` while a row held only this one; the opponent's name is a
   * link too since #1005 — a different destination, correctly named for it — so
   * the row-wide query is ambiguous, and the cell is the honest scope. *Which*
   * cell the anchor sits in is part of the contract anyway, and the
   * "puts the anchor on the DATE cell" test pins it.)
   */
  getDetailLink(opponent: string) {
    return within(whenCellOf(container, opponent)).getByRole('link')
  },
  /**
   * **Every** link in the row. Two, for a match against a person: the row's
   * stretched anchor to the match, and the opponent's name to their profile. One,
   * for a solo match — there is nobody to link to.
   *
   * Two links a screen reader hears, going to two genuinely different places, each
   * named for its own, is the design. The failure this guards against is *one*
   * link heard four times — once per cell — which is why the row's anchor is
   * stretched by a `::after` rather than repeated in every `<td>`.
   */
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
 * and, since the row holds two typed `<Link>`s (the "When" cell to the match,
 * #989; the opponent's name to their profile, #1005), a memory router registering
 * both routes for them to resolve against. The router resolves **asynchronously**:
 * start tests with `await recentMatchRowPage.findRow(…)`.
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
      { linkTargets: [PROFILE_ROUTE, MATCH_DETAIL_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
