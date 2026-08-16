// What a **swiss** event's results look like to a reader (ADR "swiss pre-cuts every round
// and pairs each one on advance") — the pure derivation behind the Events tab's swiss
// standings block, and the group-less sibling of `./standings`.
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
// **It makes ONE join, not two.** A group's standings also resolve a `groupId` to a
// position-derived label; swiss has no group to resolve, because it ranks the whole field
// in one table. That
// absence is the only thing that distinguishes this module from `./standings` — the rows
// themselves are a group's `StandingRow` plus the `buchholz` column, joined by the very same
// `nameOf`, so the withdrawn-entrant label and every number cannot fork into a second
// implementation.
//
// `buchholz` needs no work here at all, and that is the point of spreading rather than
// re-listing the columns: it is the SERVER's figure — the sum of this entrant's opponents'
// win counts — carried straight through to the cell, never re-derived from the wins column
// beside it. Re-deriving it would be a second copy of a number that already moves on its
// own (an opponent's later win raises it), and the two would disagree within a round.
//
// What it deliberately does **not** do is re-order or recompute anything: the server owns
// the finishing order and every figure (ADR-0788 — "the order *is* the result"), so the
// rows are mapped **in the order they arrive**, untouched.
//
// A pure function of one event, so it is unit-tested (`./swiss-standings.test.ts`) rather
// than asserted through a DOM.

import { nameByEntryId, nameOf } from './entrant-names'
import type {
  SwissStandingRow,
  SwissStandingsResults,
  TournamentEvent,
} from './types'

/** One swiss standings line, ready to render: the server's row — **`buchholz` included** —
 * plus the entrant's name joined from the event. The `StandingLine` of `./standings` with
 * the one extra column, and structurally assignable to it, so the shared table renders
 * either. Every number is carried through unchanged: the client shows them, it does not
 * compute them. */
export interface SwissStandingLine extends SwissStandingRow {
  /** The entrant's username (bare, no `@` — `web-client/CLAUDE.md`), or `WITHDRAWN_LABEL`
   * when the row names an entry the event no longer lists — the same join, and the same
   * word, a group's table makes. */
  name: string
}

/** A swiss event's standings, shaped for the reader: the whole field as one named table,
 * whether every round is decided, and the leader's *name* (joined) once it is. */
export interface SwissStandingsView {
  /** Every entrant, in the server's finishing order — **one list, no groups**, rendered
   * untouched. */
  rows: SwissStandingLine[]
  /** True when **every round** is decided, the later ones included. */
  complete: boolean
  /** The leader's username once the event is complete, else `null` — the server's own
   * `champion`, joined to a name. A swiss ranks its whole field, so unlike the round-robin
   * block there is no multi-group carve-out that leaves a complete event uncrowned. */
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
      // Spread, so every column the server sent rides through — `buchholz` included, and
      // whatever the shared row grows next. The join adds a name; it takes nothing away.
      (row): SwissStandingLine => ({ ...row, name: nameOf(row.entryId, names) }),
    ),
    complete: results.complete,
    champion:
      results.champion === null ? null : nameOf(results.champion, names),
  }
}
