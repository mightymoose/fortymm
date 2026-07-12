import type { components } from '@/api/schema'
import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import {
  buildPlayerMatchRow,
  buildSoloMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'

import type { PlayerMatchHistoryProps } from './player-match-history'

type PlayerMatchRow = components['schemas']['PlayerMatchRow']
type PlayerMatchListResponse = components['schemas']['PlayerMatchListResponse']

/**
 * Mirrors the `PAGE_SIZE` the component sends to
 * `GET /v1/players/{id}/matches` (25, itself the API's
 * `LIST_DEFAULT_PAGE_SIZE`). It is not exported from the component, and a test
 * that wants to cross the page boundary has to know where the boundary *is* —
 * so it is named once, here, and every fixture size is written relative to it
 * (`HISTORY_PAGE_SIZE + 1`), never as a bare `26`.
 */
export const HISTORY_PAGE_SIZE = 25

/**
 * `count` rows of match history, newest first — an **arbitrary** number of them.
 *
 * This is the builder the boundary case needs: every fixture in the repo before
 * it was a hand-written literal shorter than one page, which is exactly how a
 * truncation or an off-by-one at the page edge stays invisible. Each row is
 * distinguishable from every other one:
 *
 * - `opponent.username` is `opp.01 … opp.NN`, zero-padded so `opp.1` is not a
 *   substring of `opp.10` and an assertion on a name cannot match the wrong row;
 * - `id` and `created_at` are unique per row, so a duplicated or dropped row
 *   shows up as a changed list rather than an identical-looking one.
 *
 * The rows are otherwise the factory's default: a completed, rated win.
 */
export function buildPlayerMatchRows(
  count: number,
  overrides: Partial<PlayerMatchRow> = {},
): PlayerMatchRow[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    const label = String(n).padStart(2, '0')
    return buildPlayerMatchRow({
      id: `m-${label}`,
      opponent: { id: `p-opp-${label}`, username: `opp.${label}` },
      // Descending dates, newest first — the order the API returns them in.
      created_at: `2026-06-${String(Math.max(1, 28 - i)).padStart(2, '0')}T12:00:00Z`,
      ...overrides,
    })
  })
}

/**
 * One page of a match history, sliced out of the **whole** list the way the API
 * slices it: the `items` are only this page's rows, while `total` counts every
 * row there is.
 *
 * Keeping the total honest against the slice is the whole point — a stub that
 * echoes back `total: items.length` per page can never catch a footer that
 * miscounts across a boundary, and a stub that returns every row on every page
 * can never catch a pager that fails to advance.
 */
export function buildPlayerMatchPage(
  rows: PlayerMatchRow[],
  { page = 1, pageSize = HISTORY_PAGE_SIZE }: { page?: number; pageSize?: number } = {},
): PlayerMatchListResponse {
  const start = (page - 1) * pageSize
  return {
    items: rows.slice(start, start + pageSize),
    page,
    page_size: pageSize,
    total: rows.length,
  }
}

/**
 * The all-inclusive mix the history is required to show (ADR-0008): a live
 * match, one awaiting acceptance, an up-next one, a voided one, a loss, and the
 * player-less solo sentinel that renders as "No opponent". Nothing here may be
 * filtered out of the table.
 */
export function buildMixedStatusMatchRows(): PlayerMatchRow[] {
  return [
    buildPlayerMatchRow({
      id: 'm-live',
      status: 'in_progress',
      games: [],
      result: null,
      awaiting_acceptance: false,
      opponent: { id: 'p-l', username: 'opp.live' },
    }),
    buildPlayerMatchRow({
      id: 'm-awaiting',
      status: 'in_progress',
      result: null,
      awaiting_acceptance: true,
      opponent: { id: 'p-a', username: 'opp.awaiting' },
    }),
    buildPlayerMatchRow({
      id: 'm-up-next',
      status: 'pending',
      games: [],
      result: null,
      opponent: { id: 'p-p', username: 'opp.pending' },
    }),
    buildPlayerMatchRow({
      id: 'm-voided',
      status: 'voided',
      games: [],
      result: null,
      opponent: { id: 'p-v', username: 'opp.voided' },
    }),
    buildPlayerMatchRow({
      id: 'm-loss',
      result: 'L',
      opponent: { id: 'p-x', username: 'opp.loser' },
    }),
    buildSoloMatchRow(),
  ]
}

/**
 * Props for `PlayerMatchHistory`.
 *
 * The default is the **settled** page: a loaded player (`rita.kovac`), page 1,
 * nothing pending — so a bare `render()` paints the real table rather than the
 * skeleton. The loading window is its own named case (`isPending: true` with a
 * `null` player), because the two are distinct states of the same surface: the
 * player identity comes from the profile bundle and the table is gated behind
 * it.
 *
 * `onPageChange` is a no-op here; the page object wires the `page` /
 * `onPageChange` pair to real state so the pager actually pages.
 */
export function buildPlayerMatchHistoryProps(
  overrides: Partial<PlayerMatchHistoryProps> = {},
): PlayerMatchHistoryProps {
  const player = buildPlayerDetail()
  return {
    playerId: player.id,
    player,
    isPending: false,
    page: 1,
    onPageChange: () => {},
    ...overrides,
  }
}
