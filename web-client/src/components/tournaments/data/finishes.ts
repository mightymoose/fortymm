// What a single-elimination event's **results** look like to a reader (ADR-0785) — the
// pure derivation behind the Events tab's **finishes** placement list, the `finishes` twin
// of `./standings`.
//
// The wire gives us the `finishes` arm of `EventResults` (parsed at the boundary by
// `./results`): a list of finish rows keyed by entry id, each with a server-assigned
// finishing `position`, plus a champion that is an entry id. A director reads a **named**
// placement list with a **named** champion, so this module makes the same join `./standings`
// makes — an entry id → a username off the event's `entrants` — and nothing more.
//
// What it deliberately does **not** do is compute a placement: the **server** owns the
// finishing positions (derived live from the round each entrant was eliminated in), and the
// rows arrive in its order — position ascending, ties sharing a position (ADR-0785 — "the
// order *is* the result"). This module maps them in that order, untouched. The only thing it
// derives is *presentation*: whether a position is **shared** (so the list renders it as a
// tie, `T3`, rather than fabricating an order single-elimination never produced), which is a
// fact about the rows the server sent, not a re-ranking of them.
//
// All of it is a pure function of one event, so it is unit-tested (`./finishes.test.ts`)
// rather than asserted through a DOM.

import { nameByEntryId, nameOf } from './entrant-names'
import type { FinishesResults, FinishRow, TournamentEvent } from './types'

/** One placement line, ready to render: the server's finish row, the entrant's name joined
 * from the event, and the presentation flags the list needs. Every figure is carried
 * through unchanged — the client shows the position, it does not compute it. */
export interface FinishLine extends FinishRow {
  /** The entrant's username (bare, no `@` — `web-client/CLAUDE.md`), or `WITHDRAWN_LABEL`
   * when the row names an entry the event no longer lists (a player who withdrew after
   * being placed). Never a blank, and never the raw id. */
  name: string
  /** True when another finish shares this `position` — same-round losers whom
   * single-elimination does not rank against each other. The list renders a tie (`T3`)
   * rather than an ordinal, so it never implies an order the format did not produce. */
  tied: boolean
  /** True for finishing position 1 — the champion, highlighted in the list. */
  isChampion: boolean
  /** The position as the list shows it: an ordinal (`1st`, `2nd`) when this entrant holds
   * the position alone, or a tie (`T3`, `T5`) when it is shared. */
  positionLabel: string
}

/** A single-elimination event's results, shaped for the reader: the placement list (names
 * joined, ties marked), whether the bracket is decided, and the champion's *name* when
 * there is one. */
export interface FinishesView {
  finishes: FinishLine[]
  complete: boolean
  /** The champion's username when the final is decided, else `null` — the server's own
   * `champion`, joined to a name. */
  champion: string | null
}

/** `1 → "1st"`, `2 → "2nd"`, `3 → "3rd"`, `21 → "21st"` — English ordinal, for a position
 * held **alone**. (`11`–`13` are the "-th" exceptions.) A shared position never uses this;
 * it renders `T{position}` instead. */
function ordinal(position: number): string {
  const mod100 = position % 100
  if (mod100 >= 11 && mod100 <= 13) return `${position}th`
  switch (position % 10) {
    case 1:
      return `${position}st`
    case 2:
      return `${position}nd`
    case 3:
      return `${position}rd`
    default:
      return `${position}th`
  }
}

/**
 * A **finishes block**, shaped for the reader — always a view, never `null`.
 *
 * Like `./standings`, it is handed the block rather than digging one out of the event: it
 * does not decide whether it applies. **The caller that switches on `results.kind` does**
 * (`ResultsPanel`), and it is the only place that knows an event may have no results at
 * all. Everything here is a total function of the block plus the `event` the name join
 * needs (entry id → username).
 *
 * The rows are mapped **in the order the server sent them** (position ascending, ties
 * together): the server derived the placement from each entrant's elimination round, and
 * re-ordering it here — even by the visible `position` — would be the client second-guessing
 * a result it does not own. The one thing derived is `tied`: a position is a tie exactly when
 * more than one finish shares it (same-round losers), so the list can render it honestly.
 */
export function eventFinishes(
  event: TournamentEvent,
  results: FinishesResults,
): FinishesView {
  const names = nameByEntryId(event)

  // How many finishes share each position — the tie test. A partially-played bracket sends
  // only the finishes so far, so this counts exactly what is on the wire, never a full field.
  const countByPosition = new Map<number, number>()
  for (const row of results.finishes) {
    countByPosition.set(row.position, (countByPosition.get(row.position) ?? 0) + 1)
  }

  const finishes = results.finishes.map((row): FinishLine => {
    const tied = (countByPosition.get(row.position) ?? 0) > 1
    return {
      ...row,
      name: nameOf(row.entryId, names),
      tied,
      isChampion: row.position === 1,
      positionLabel: tied ? `T${row.position}` : ordinal(row.position),
    }
  })

  return {
    finishes,
    complete: results.complete,
    champion:
      results.champion === null ? null : nameOf(results.champion, names),
  }
}
