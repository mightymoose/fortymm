import {
  MATCH_DETAIL_ROUTE,
  matchRowLinkPage,
} from '@/components/matches/match-row-link/match-row-link.page'
import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

import { MatchHistoryRow, type MatchHistoryRowProps } from './match-history-row'
import { buildMatchHistoryRowProps } from './match-history-row.factory'

/** The `<tr>` an opponent's name sits in — rows are told apart the way a reader
 * tells them apart, by who the match was against. */
const rowOf = (container: Container, opponent: string): HTMLElement => {
  const row = container.getByText(opponent).closest('tr')
  if (!row) throw new Error(`No history row for opponent "${opponent}"`)
  return row as HTMLElement
}

const scoped = (container: Container) => ({
  /** One match's row, by opponent ("No opponent" for a solo match). */
  getRow(opponent: string) {
    return rowOf(container, opponent)
  },
  /** The same row, awaited — the harness mounts a router (the date cell is a
   * typed `<Link>`), and it resolves asynchronously. */
  async findRow(opponent: string) {
    await container.findByText(opponent)
    return rowOf(container, opponent)
  },
  /** The row's link to its match: a real `<a href="/matches/<uuid>">` stretched
   * across the row (#989). Assert the **href** — "a link exists" was never the
   * claim. Exactly one per row, hence the bare `getByRole('link')`. */
  getDetailLink(opponent: string) {
    return within(rowOf(container, opponent)).getByRole('link')
  },
  /** Every link in the row — one, always. */
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
 * The component renders a `<tr>`, so `render` supplies the surrounding table, and
 * — since its date cell is a typed `<Link>` to the match — a memory router that
 * registers `/matches/$matchId`. The router resolves asynchronously: start tests
 * with `await matchHistoryRowPage.findRow(…)`.
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
      { linkTargets: [MATCH_DETAIL_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
