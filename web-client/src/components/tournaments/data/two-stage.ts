// What a **round-robin-then-knockout** event's results look like to a reader (ADR
// 20260727) — the pure derivation behind the Events tab's two-stage block, and the
// composite of `./standings` and `./finishes` rather than a third copy of either.
//
// The wire gives us the `standings_then_finishes` arm of `EventResults` (parsed at the
// boundary by `./results`): one **pool-stage** standings block, one **knockout-stage**
// finishes block, and a single `complete`/`champion` pair describing the event as a whole.
// Both blocks are the very models the other two arms carry, so this module makes no joins
// of its own beyond the champion's — it hands each block to the selector that already
// shapes it (`eventStandings`, `eventFinishes`) and composes the two views.
//
// **The champion belongs to the event, not to a stage** (ADR 20260727: "the champion comes
// from the bracket — never from a pool"), so it is lifted out of both sub-views and named
// once, here:
//
// - the **standings** sub-view is given `champion: null` because a pool stage genuinely
//   crowns nobody. Topping a pool wins nothing in this format; it seeds a bracket slot.
// - the **finishes** sub-view is given `champion: null` too — not because the bracket has
//   no winner, but because this composite shows that winner **once**, above both stages.
//   Leaving it on the sub-view would print the same fact twice on one card.
//
// Everything else is carried straight through: neither stage is re-ordered or recomputed
// (the order *is* the result), and `complete` is the server's — **both** stages decided,
// never either. A mid-flight event is the ordinary case, not an edge: complete pools, a
// finishes list that starts below 1st, no champion.
//
// A pure function of one event, so it is unit-tested (`./two-stage.test.ts`) rather than
// asserted through a DOM.

import { nameByEntryId, nameOf } from './entrant-names'
import { eventFinishes, type FinishesView } from './finishes'
import { eventStandings, type StandingsView } from './standings'
import type { StandingsThenFinishesResults, TournamentEvent } from './types'

/** A two-stage event's results, shaped for the reader: the pool stage's tables, the
 * knockout stage's placements, and the one champion the two stages produce between them. */
export interface TwoStageView {
  /** The **pool stage**, exactly as a round-robin's standings render — minus a champion,
   * which a pool stage does not award. */
  standings: StandingsView
  /** The **knockout stage**, exactly as a single-elimination's finishes render — minus a
   * champion, which the composite names once above both stages. */
  finishes: FinishesView
  /** True when **both** stages are decided. */
  complete: boolean
  /** The champion's username — the **bracket final's** winner, joined from the server's
   * `champion` entry id — or `null` until that final is decided. Never a pool leader. */
  champion: string | null
}

/**
 * A **two-stage results block**, shaped for the reader — always a view, never `null`.
 *
 * Like its two halves it is handed the block rather than digging one out of the event: it
 * does not decide whether it applies. **The caller that switches on `results.kind` does**
 * (`ResultsPanel`), and it is the only place that knows an event may have no results at
 * all.
 *
 * It composes the existing selectors instead of re-deriving either stage. That is what
 * keeps a two-stage event's pool table identical to a round-robin's and its placement list
 * identical to a single-elimination's — including the tie labels and the withdrawn-entrant
 * join, which would otherwise be a second implementation waiting to disagree.
 */
export function eventStandingsThenFinishes(
  event: TournamentEvent,
  results: StandingsThenFinishesResults,
): TwoStageView {
  const names = nameByEntryId(event)

  return {
    // `champion: null` on both sub-blocks is the composite's decision, not a claim about
    // the data — see the module note. The event's champion is named below, once.
    standings: eventStandings(event, {
      kind: 'standings',
      pools: results.pools,
      complete: results.complete,
      champion: null,
    }),
    finishes: eventFinishes(event, {
      kind: 'finishes',
      finishes: results.finishes,
      complete: results.complete,
      champion: null,
    }),
    complete: results.complete,
    // The BRACKET's winner. Read off `results.champion` — the server's own figure — and
    // never off the top of a standings table, which would crown whoever led a pool.
    champion:
      results.champion === null ? null : nameOf(results.champion, names),
  }
}
