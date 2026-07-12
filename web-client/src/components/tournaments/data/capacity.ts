// How much room an event has left — the *event's* side of entry (#783), as
// opposed to the *caller's* side, which is `entryControlState` (`./lifecycle`).
//
// ⚠️ It reads the NUMBERS (`entered` vs `maxPlayers`), never `entryState`, and
// that is the one decision in this file:
//
// - `entered` is the count of active entrants, derived server-side from the rows
//   (ADR-0016) — a fact about the EVENT, true for everyone looking at it.
// - `entryState` is **caller-aware** (ADR-0783): the server judges eligibility
//   *before* capacity, so a rating-ineligible player reading a FULL event is told
//   `rating_ineligible` — the `event_full` arm never reaches them. A capacity line
//   keyed off `entryState` would therefore quietly stop saying "Full" to exactly
//   the player it is not talking about, and would have nothing at all to say about
//   how many places are left (the tag carries no count).
//
// So: `entryState` decides **what this caller may do** (a button, or copy in its
// place); this module decides **what the event has left** (a fill bar and a
// caption). Two different questions, and only one of them has an answer that
// depends on who is asking.
//
// This is not the client re-deriving the server's *judgement*: nothing here is
// consulted about whether an Enter button appears. It is the client reading two
// integers it was sent, which is all "how many places are left" has ever been.

import type { TournamentEvent } from './types'

/** The three — mutually exclusive — things an event's capacity can say, as a sum
 * type rather than a `remaining: number` a caller must remember to clamp and
 * branch on. `remaining` exists only on the arm where there IS a remainder, so
 * "0 places left" and "-3 places left" are not sentences this module can be made
 * to speak.
 *
 * `uncapped` is the ADR-0935 arm: `max_players` is nullable, and `null` means the
 * event admits everyone. It is **not** a very large cap, and must not be modelled
 * as one — an uncapped event has no denominator, so there is no bar to fill, no
 * number of places to count down, and (the load-bearing part) *no way for it to be
 * full*. Give it a `remaining` and something eventually prints "Infinity places
 * left"; give it a fabricated denominator and the card reads "12 of 0" and calls
 * the event full on the day it opens.
 *
 * `full` carries nothing: "no room" is the whole fact. *How far past* full an
 * over-full event is (see `eventCapacity`) is a director's problem, not a
 * prospective entrant's. */
export type EventCapacity =
  | { state: 'uncapped' }
  | { state: 'places-left'; remaining: number }
  | { state: 'full' }

/** The two values a capacity reading needs. Narrower than `TournamentEvent` so
 * the tests can state a case in the numbers it is about. */
type Capacity = Pick<TournamentEvent, 'entered' | 'maxPlayers'>

/**
 * What this event has left.
 *
 * **A null cap is asked about FIRST**, because it is not an arithmetic case: the
 * server guarantees an uncapped event is never `event_full` (ADR-0935), and the
 * only way for this module to agree with it is to never do the subtraction. Every
 * arithmetic answer would be wrong — TypeScript's `null` coerces to `0`, so
 * `maxPlayers - entered` on an uncapped event is a *negative* number of places,
 * which reads as **full** the moment anybody enters.
 *
 * For a capped event: **`>=`, not `===`** — the same comparison the server's
 * capacity guard makes (`event_is_full`, `api/app/tournaments.py`). An event can
 * hold *more* entrants than `max_players`: a director who lowers the cap under a
 * field that has already formed does not evict anybody, so `entered > maxPlayers`
 * is a real, representable state. It is full — emphatically so — and the naive
 * `maxPlayers - entered` would render it as **"-3 places left"**, which is not a
 * number of places.
 */
export function eventCapacity(event: Capacity): EventCapacity {
  if (event.maxPlayers === null) return { state: 'uncapped' }
  const remaining = event.maxPlayers - event.entered
  return remaining > 0 ? { state: 'places-left', remaining } : { state: 'full' }
}

/** The capacity in the domain's words: that there is no limit, how many places are
 * left, or that there are none. Singular is not a nicety — "1 places left" on the
 * last free place is the copy a player is most likely to be reading. */
export function capacityLabel(capacity: EventCapacity): string {
  switch (capacity.state) {
    // Said out loud, and said in the affirmative: silence here would leave the
    // uncapped event as the one card with a blank where every other card states a
    // fact — and a blank is what a reader fills in with a guess. "No entry limit"
    // is the fact.
    case 'uncapped':
      return 'No entry limit'
    case 'full':
      return 'Full'
    case 'places-left': {
      const { remaining } = capacity
      return `${remaining} ${remaining === 1 ? 'place' : 'places'} left`
    }
  }
}

/** The count as a **sentence**, for the assistive-technology reading of the
 * `12 / 64` numeral — which is a typographic device, not language: a screen
 * reader announcing "12 slash 64" has said nothing about entries. The card hides
 * the numeral from the accessibility tree and offers this instead, so the two
 * cannot be read twice (ADR-0016's vocabulary: the people in an event are its
 * *entrants*).
 *
 * An uncapped event has no denominator to read out, so the sentence gives the count
 * and then says *why* there is no second number — rather than inventing one. */
export function enteredSummary(event: Capacity): string {
  if (event.maxPlayers === null) return `${event.entered} entered, no entry limit`
  return `${event.entered} of ${event.maxPlayers} entered`
}

/** How full the fill bar is drawn, 0–100 — or **`null` when there is no bar to
 * draw**. An uncapped event has no denominator, so it has no fill: `0` would draw
 * an empty rail on an event that may already hold two hundred people, and `100`
 * would draw a full one on an event that can never be full. Neither is a percentage
 * of anything, so neither is returned, and the caller renders no bar at all.
 *
 * For a capped event it is clamped at both ends: an over-full event is a full bar,
 * never one that overflows its rail. */
export function capacityFillPercent(event: Capacity): number | null {
  if (event.maxPlayers === null) return null
  // The DB's `CHECK (max_players > 0)` makes a zero cap unrepresentable server-side
  // (ADR-0935); this is the client's own guard against dividing by one regardless.
  if (event.maxPlayers <= 0) return 100
  const pct = Math.round((event.entered / event.maxPlayers) * 100)
  return Math.min(100, Math.max(0, pct))
}
