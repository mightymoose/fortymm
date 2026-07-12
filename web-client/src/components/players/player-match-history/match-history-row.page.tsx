import {
  MATCH_DETAIL_ROUTE,
  matchRowLinkPage,
} from '@/components/matches/match-row-link/match-row-link.page'
import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

import { MatchHistoryRow, type MatchHistoryRowProps } from './match-history-row'
import { buildMatchHistoryRowProps } from './match-history-row.factory'

/** The route an opponent's name opens: that player's profile (#1005). Registered
 * as a stub in the harness so the typed `<Link>` resolves. */
export const PROFILE_ROUTE = '/players/$userId'

/** The `<tr>` an opponent's name sits in — rows are told apart the way a reader
 * tells them apart, by who the match was against. */
const rowOf = (container: Container, opponent: string): HTMLElement => {
  const row = container.getByText(opponent).closest('tr')
  if (!row) throw new Error(`No history row for opponent "${opponent}"`)
  return row as HTMLElement
}

const cellsOf = (container: Container, opponent: string) =>
  within(rowOf(container, opponent)).getAllByRole('cell')

/** The Date cell — the first. It holds the row's link to the match. */
const dateCellOf = (container: Container, opponent: string) =>
  cellsOf(container, opponent)[0]

/** The Opponent cell — the second. It holds the link to the person. */
const opponentCellOf = (container: Container, opponent: string) =>
  cellsOf(container, opponent)[1]

const scoped = (container: Container) => ({
  /** One match's row, by opponent ("No opponent" for a solo match). */
  getRow(opponent: string) {
    return rowOf(container, opponent)
  },
  /** The same row, awaited — the harness mounts a router (the date cell and the
   * opponent's name are both typed `<Link>`s), and it resolves asynchronously. */
  async findRow(opponent: string) {
    await container.findByText(opponent)
    return rowOf(container, opponent)
  },
  /**
   * The row's link to its match: a real `<a href="/matches/<uuid>">` stretched
   * across the row (#989). Assert the **href** — "a link exists" was never the
   * claim.
   *
   * Scoped to the **Date cell**, not the row: a row holds two links now (the
   * opponent's name is one too, going somewhere else), so a row-wide
   * `getByRole('link')` is ambiguous. *Which* cell the anchor sits in is part of
   * the contract anyway, and "puts the anchor on the DATE cell" pins it.
   */
  getDetailLink(opponent: string) {
    return within(dateCellOf(container, opponent)).getByRole('link')
  },
  /**
   * The opponent's name **as a link** to their profile (#1005). `null` for a solo
   * match — there is nobody on the other side to link to.
   *
   * By *role* and by name, scoped to the Opponent cell: a `<span>` styled like a
   * link is still a dead end, and this can never collide with the row's own link,
   * which lives in the Date cell and is named for the match.
   */
  queryOpponentLink(opponent: string) {
    return within(opponentCellOf(container, opponent)).queryByRole('link', {
      name: opponent,
    })
  },
  getOpponentLink(opponent: string) {
    return within(opponentCellOf(container, opponent)).getByRole('link', {
      name: opponent,
    })
  },
  /**
   * Every link in the row: **two** for a match against a person — the match, and
   * the person — and one for a solo match, which has nobody to link to.
   *
   * Two links a screen reader hears, each named for a genuinely different
   * destination. What this guards against is one link heard *four* times, once per
   * cell; that is why the row's anchor is stretched by a `::after` rather than
   * repeated in every `<td>`.
   */
  getRowLinks(opponent: string) {
    return within(rowOf(container, opponent)).queryAllByRole('link')
  },
  /** The result chip ("WIN" / "LOSS" / "LIVE" / "AWAITING" / "UP NEXT" / …). */
  getResultChip(opponent: string) {
    const chip = rowOf(container, opponent).querySelector(
      '.player-profile__result-chip',
    )
    if (!chip) throw new Error(`No result chip in the row for "${opponent}"`)
    return chip as HTMLElement
  },
  /** The per-game score chips, in play order, from the player's perspective. */
  getGameChips(opponent: string) {
    return Array.from(
      rowOf(container, opponent).querySelectorAll('.player-profile__game'),
    ) as HTMLElement[]
  },
  ...matchRowLinkPage.within(container),
})

/**
 * Test page-object for `MatchHistoryRow` — one row of the full history table.
 *
 * The component renders a `<tr>`, so `render` supplies the surrounding table —
 * and, since the row holds two typed `<Link>`s (the date cell to the match, #989;
 * the opponent's name to their profile, #1005), a memory router registering both
 * routes. The router resolves asynchronously: start tests with
 * `await matchHistoryRowPage.findRow(…)`.
 */
export const matchHistoryRowPage = {
  render(overrides: Partial<MatchHistoryRowProps> = {}) {
    const props = buildMatchHistoryRowProps(overrides)
    return renderWithRoutes(
      <table>
        <tbody>
          <MatchHistoryRow {...props} />
        </tbody>
      </table>,
      { linkTargets: [MATCH_DETAIL_ROUTE, PROFILE_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
