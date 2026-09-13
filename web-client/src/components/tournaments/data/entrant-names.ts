// The entry-id → username join the results view-models share. A wire row (a standings row,
// a finish) carries an entry *id*, not a name; the username behind it is already on the
// event (visible and retained entrants are keyed by that id). Results selectors make the
// exact same join, so it lives here once — copying it would let the two drift.

import { historicalEntrants } from './entrants'
import { WITHDRAWN_LABEL } from './draw'
import type { TournamentEvent } from './types'

/** Build the event's entry-id → username lookup, keyed the way the wire rows reference
 * entrants. Both results view-models join through this same map. */
export function nameByEntryId(event: TournamentEvent): Map<string, string> {
  return new Map(historicalEntrants(event).map((e) => [e.id, e.username]))
}

/** Join one entry id to a display name. An id the event no longer lists is a withdrawal
 * (`WITHDRAWN_LABEL`, shared with `./draw`) — never a blank, and never the raw id. */
export function nameOf(entryId: string, byId: Map<string, string>): string {
  return byId.get(entryId) ?? WITHDRAWN_LABEL
}
