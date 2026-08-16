// What an event's **results** look like to a reader (ADR-0788) — the pure derivation
// behind the Events tab's standings tables, the twin of `./draw` for the results block.
//
// The wire gives us `EventResults` (parsed at the boundary by `./results`): group
// standings keyed by group id, rows keyed by entry id, and a champion that is an entry id.
// A director reads standings as a **named** table per group, with a **named** champion.
// Nothing on the wire is shaped that way, and deliberately so — the same two joins the
// draw makes:
//
// - **Names are not on a row.** A row carries an entry *id*; the username behind it is
//   already on the event (`entrants` is keyed by that id), so the join happens here, once.
//   Copying the username onto the row would carry a field and its own derivation, and the
//   two copies would drift the moment a player is renamed.
// - **A group carries no name of its own** (ticket #1369 — a group is server-owned and
//   read-only; only its `position` is a fact about it). The table titles itself from
//   `groupLetter(group.position)` (`./draw-structure`) — `Group A`, `Group B`, … — never
//   from a reservation's director-typed name, which names the venue booking, not the
//   competitive group.
//
// What it deliberately does **not** do is re-order or recompute anything: the server owns
// the finishing order and every number (ADR-0788 — "the order *is* the result"), so the
// rows are mapped **in the order they arrive**, untouched. This module only joins the ids
// to names/labels.
//
// All of it is a pure function of one event, so it is unit-tested (`./standings.test.ts`)
// rather than asserted through a DOM.

import { groupLetter } from './draw-structure'
import { nameByEntryId, nameOf } from './entrant-names'
import type { StandingRow, StandingsResults, TournamentEvent } from './types'

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

/** One group's standings table, labelled and joined: the group's position-derived label
 * (`Group A`, `Group B`, …), its rows in the server's finishing order, and whether it is
 * decided. */
export interface GroupStandingsView {
  groupId: string
  /** `Group A`, `Group B`, … — `groupLetter(group.position)`, never a stored name (a
   * group carries none). */
  label: string
  rows: StandingLine[]
  complete: boolean
}

/**
 * The fields `eventStandings` actually reads — a **standings block**: the group tables,
 * whether that block is decided, and its champion when it has one.
 *
 * A whole round-robin event's `StandingsResults` is one of these; so is the **group stage**
 * of a two-stage event, which is not a `StandingsResults` at all (`./two-stage`). The
 * parameter is this rather than the tagged arm precisely so a composite can hand over the
 * block it genuinely holds instead of minting a `kind: 'standings'` value the server would
 * never send — a boundary type is parsed at the edge and carried inward, never constructed
 * inward (`.claude/rules/parse-at-boundaries.md`).
 */
export type StandingsBlock = Omit<StandingsResults, 'kind'>

/** A standings block, shaped for the reader: labelled group tables, whether the block is
 * complete, and the champion's *name* (joined) when there is one. */
export interface StandingsView {
  groups: GroupStandingsView[]
  /** True when **this standings block** is decided — every fixture of every group played.
   * For a round-robin event that is the event itself; for the group stage of a two-stage
   * event it is that *stage*, which is decided long before the event is (`./two-stage`). */
  complete: boolean
  /** The champion's username when the event is a complete single group, else `null` — the
   * server's own `champion`, joined to a name. `null` while any fixture is unplayed, and
   * for a multi-group event (no single champion without a knockout stage yet). */
  champion: string | null
}

/**
 * A **standings block**, shaped for the reader — always a view, never `null`.
 *
 * It is handed the block rather than digging one out of the event, so it does not decide
 * whether it applies: **the caller that switches on `results.kind` does**
 * (`ResultsPanel`), and it is the only place that knows an event may have no results at
 * all. Everything here is a total function of the two arguments — the block, plus the
 * `event` the id join needs (entry id → username); the group label is derived from
 * position alone and needs no lookup into the event at all.
 *
 * The block is a `StandingsBlock`, not the `standings` arm itself, so the group stage of a
 * two-stage event can be rendered through this same selector without anybody forging a
 * `kind` for it.
 *
 * The rows are mapped **in the order the server sent them**: standings are a total order
 * the server computed (wins → two-way head-to-head → game difference → games won), and
 * re-sorting them here — even by the same visible keys — would be the client second-
 * guessing a result it does not own, and would silently disagree the day a tiebreaker the
 * client cannot see (head-to-head) decides two equal rows.
 */
export function eventStandings(
  event: TournamentEvent,
  results: StandingsBlock,
): StandingsView {
  const names = nameByEntryId(event)
  const positionByGroupId = new Map(event.groups.map((g) => [g.id, g.position]))

  const groups = results.groups.map(
    (group): GroupStandingsView => ({
      groupId: group.groupId,
      // A group the standings name but the event does not list would be a payload the
      // server cannot send; falling back to the raw id keeps the table titled rather
      // than blank if it ever did.
      label:
        positionByGroupId.get(group.groupId) !== undefined
          ? `Group ${groupLetter(positionByGroupId.get(group.groupId) as number)}`
          : group.groupId,
      rows: group.rows.map(
        (row): StandingLine => ({
          ...row,
          name: nameOf(row.entryId, names),
        }),
      ),
      complete: group.complete,
    }),
  )

  return {
    groups,
    complete: results.complete,
    champion:
      results.champion === null ? null : nameOf(results.champion, names),
  }
}
