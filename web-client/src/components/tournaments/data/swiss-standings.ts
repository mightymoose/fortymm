// What a **swiss** event's results look like to a reader (ADR "swiss pre-cuts every round
// and pairs each one on advance") — the pure derivation behind the Events tab's swiss
// standings block, and the pool-less sibling of `./standings`.
//
// The wire gives us the `swiss_standings` arm of `EventResults` (parsed at the boundary by
// `./results`): **one list of rows over the whole field**, keyed by entry id, plus whether
// every round is decided and a champion that is an entry id. A director reads that as a
// **named** table with a **named** leader, and nothing on the wire is shaped that way —
// deliberately, and for the reason `./standings` gives: a row carries an entry *id*, the
// username behind it is already on the event (`entrants` is keyed by that id), so the join
// happens here, once. Copying the username onto the row would carry a field and its own
// derivation, and the two would drift the moment a player is renamed.
//
// **It makes ONE join, not two.** A pool's standings also resolve a `poolId` to a pool
// name; swiss has no pool to resolve, because it ranks the whole field in one table. That
// absence is the only thing that distinguishes this module from `./standings` — the rows
// themselves are the very `StandingRow`s a pool carries, joined by the very same
// `nameOf`, so the withdrawn-entrant label and every number cannot fork into a second
// implementation.
//
// What it deliberately does **not** do is re-order or recompute anything: the server owns
// the finishing order and every figure (ADR-0788 — "the order *is* the result"), so the
// rows are mapped **in the order they arrive**, untouched.
//
// A pure function of one event, so it is unit-tested (`./swiss-standings.test.ts`) rather
// than asserted through a DOM.

import { nameByEntryId, nameOf } from './entrant-names'
import type { StandingLine } from './standings'
import type { SwissStandingsResults, TournamentEvent } from './types'

/** A swiss event's standings, shaped for the reader: the whole field as one named table,
 * whether every round is decided, and the leader's *name* (joined) once it is. */
export interface SwissStandingsView {
  /** Every entrant, in the server's finishing order — **one list, no pools**, rendered
   * untouched. */
  rows: StandingLine[]
  /** True when **every round** is decided, the later ones included. */
  complete: boolean
  /** The leader's username once the event is complete, else `null` — the server's own
   * `champion`, joined to a name. A swiss ranks its whole field, so unlike the round-robin
   * block there is no multi-pool carve-out that leaves a complete event uncrowned. */
  champion: string | null
}

/**
 * A **swiss standings block**, shaped for the reader — always a view, never `null`.
 *
 * Like `eventStandings` it is handed the block rather than digging one out of the event, so
 * it does not decide whether it applies: **the caller that switches on `results.kind` does**
 * (`ResultsPanel`), and it is the only place that knows an event may have no results at all.
 *
 * The rows are mapped **in the order the server sent them**. Re-sorting them here — even by
 * the same visible keys — would be the client second-guessing a result it does not own, and
 * would silently disagree the day a tiebreaker the client cannot see (head-to-head, and
 * Buchholz once it lands) decides two level rows. In swiss that is not a corner case: the
 * format pairs by score, so level rows are the ordinary state of the table.
 */
export function eventSwissStandings(
  event: TournamentEvent,
  results: SwissStandingsResults,
): SwissStandingsView {
  const names = nameByEntryId(event)

  return {
    rows: results.rows.map(
      (row): StandingLine => ({ ...row, name: nameOf(row.entryId, names) }),
    ),
    complete: results.complete,
    champion:
      results.champion === null ? null : nameOf(results.champion, names),
  }
}
