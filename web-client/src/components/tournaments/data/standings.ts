// What an event's **results** look like to a reader (ADR-0788) — the pure derivation
// behind the Events tab's standings tables, the twin of `./draw` for the results block.
//
// The wire gives us `EventResults` (parsed at the boundary by `./results`): pool
// standings keyed by pool id, rows keyed by entry id, and a champion that is an entry id.
// A director reads standings as a **named** table per pool, with a **named** champion.
// Nothing on the wire is shaped that way, and deliberately so — the same two joins the
// draw makes:
//
// - **Names are not on a row.** A row carries an entry *id*; the username behind it is
//   already on the event (`entrants` is keyed by that id), so the join happens here, once.
//   Copying the username onto the row would carry a field and its own derivation, and the
//   two copies would drift the moment a player is renamed.
// - **Pool names are not on a pool's standings.** They carry a `poolId`, a string ref into
//   the event's own `pools` — so the table titles itself from the pool the page holds.
//
// What it deliberately does **not** do is re-order or recompute anything: the server owns
// the finishing order and every number (ADR-0788 — "the order *is* the result"), so the
// rows are mapped **in the order they arrive**, untouched. This module only joins the two
// ids to names.
//
// All of it is a pure function of one event, so it is unit-tested (`./standings.test.ts`)
// rather than asserted through a DOM.

import { WITHDRAWN_LABEL } from './draw'
import type { StandingRow, TournamentEvent } from './types'

/** One standings line, ready to render: the server's row, plus the entrant's name joined
 * from the event. The row's every number is carried through unchanged — see the module
 * note: the client shows them, it does not compute them. */
export interface StandingLine extends StandingRow {
  /** The entrant's username (bare, no `@` — `web-client/CLAUDE.md`), or `WITHDRAWN_LABEL`
   * when the row names an entry the event no longer lists: a player who withdrew after
   * playing, whose completed matches still count toward the numbers but who is no longer
   * an entrant (ADR-0016). Never a blank, and never the raw id. */
  name: string
}

/** One pool's standings table, named and joined: the pool's name (from the event's
 * `pools`), its rows in the server's finishing order, and whether it is decided. */
export interface PoolStandingsView {
  poolId: string
  name: string
  rows: StandingLine[]
  complete: boolean
}

/** An event's results, shaped for the reader: named pool tables, whether the event is
 * complete, and the champion's *name* (joined) when there is one. */
export interface StandingsView {
  pools: PoolStandingsView[]
  complete: boolean
  /** The champion's username when the event is a complete single pool, else `null` — the
   * server's own `champion`, joined to a name. `null` while any fixture is unplayed, and
   * for a multi-pool event (no single champion without a knockout stage yet). */
  champion: string | null
}

/** Join one entry id to a display name. An id the event no longer lists is a withdrawal
 * (`WITHDRAWN_LABEL`, shared with `./draw`) — never a blank, and never the raw id. */
function nameOf(entryId: string, byId: Map<string, string>): string {
  return byId.get(entryId) ?? WITHDRAWN_LABEL
}

/**
 * An event's results, shaped for the reader — or `null` when the event has none (an uncut
 * or non-round-robin event; `results` is `null` on the wire, and this returns `null`
 * straight through, so the panel renders nothing).
 *
 * The rows are mapped **in the order the server sent them**: standings are a total order
 * the server computed (wins → two-way head-to-head → game difference → games won), and
 * re-sorting them here — even by the same visible keys — would be the client second-
 * guessing a result it does not own, and would silently disagree the day a tiebreaker the
 * client cannot see (head-to-head) decides two equal rows.
 */
export function eventStandings(event: TournamentEvent): StandingsView | null {
  const results = event.results
  if (results === null) return null

  const nameByEntryId = new Map(event.entrants.map((e) => [e.id, e.username]))
  const poolNameById = new Map(event.pools.map((p) => [p.id, p.name]))

  const pools = results.pools.map(
    (pool): PoolStandingsView => ({
      poolId: pool.poolId,
      // A pool the standings name but the event does not list would be a payload the
      // server cannot send; falling back to the id keeps the table titled rather than
      // blank if it ever did.
      name: poolNameById.get(pool.poolId) ?? pool.poolId,
      rows: pool.rows.map(
        (row): StandingLine => ({
          ...row,
          name: nameOf(row.entryId, nameByEntryId),
        }),
      ),
      complete: pool.complete,
    }),
  )

  return {
    pools,
    complete: results.complete,
    champion:
      results.champion === null ? null : nameOf(results.champion, nameByEntryId),
  }
}
