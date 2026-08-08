// A refusal is a statement about a MOMENT — and this is what stops it outliving that
// moment (#1049, #1216, #1123).
//
// Both inline-refusal surfaces on the tournament detail page held their notice in a plain
// `useState` cleared only when the *next* attempt started. Nothing else could clear it, so
// a director who read a refusal and then went and fixed the thing it named was left with
// the old sentence contradicting the page around it: "This tournament has no events"
// above a page reading **1 EVENTS**, or "This event can't be drawn yet — a single-elim
// draw cannot be cut yet" on an event whose draw type is now Round robin.

import { useState } from 'react'

/**
 * Hold a notice only while the state it describes still stands.
 *
 * `scope` is a **fingerprint of the facts the refusal is about** — not of the whole
 * tournament, and emphatically not of everything that can change on the page. The setter
 * stamps the notice with the scope current at the moment it is called, and the notice is
 * rendered only while the page's scope still matches that stamp. Change the state the
 * refusal was about and it goes; leave it alone and it stays, for as long as the director
 * needs to read it.
 *
 * ## Why the fingerprint must stay narrow
 *
 * This page **polls** (`useSchedulePolling`, ~3s on the Schedule tab), so a scope that
 * caught everything — `updatedAt`, `latestScheduleSolve`, the whole serialised tournament
 * — would blink refusals off the screen for reasons that have nothing to do with what they
 * said. Each caller therefore builds its scope from the inputs its refusals actually assert
 * over (`lifecycleRefusalScope`, `drawRefusalScope`), and those functions are the place to
 * look before adding a field.
 *
 * A scope is **stable under a no-op refetch**: TanStack Query's structural sharing means a
 * poll returning equal data yields an equal string, so the notice survives it.
 *
 * ## The stamp is taken at the click, not at the error
 *
 * The setter closes over the scope of the render it was created in, which is the render the
 * director clicked in — so a notice is pinned to *the state the attempt was made against*,
 * which is the state the server judged. If that state changes while the request is in
 * flight, the answer coming back is already stale and is correctly dropped rather than
 * shown against a page it no longer describes.
 *
 * ## The reset is a render-phase `setState`, deliberately
 *
 * Not an effect (that would render the stale notice once before clearing it), and not a
 * derived value alone: a *purely* derived notice comes back from the dead when the scope
 * returns to an earlier value. A player enters — the "0 entrants" refusal hides — and then
 * withdraws, and a derived-only notice would reappear as if it had just been refused
 * again. Dropping the held value outright is what makes the clear permanent. Calling
 * `setState` during the render of the same component is the React-documented way to adjust
 * state when the props it depended on change; React discards this pass and re-runs before
 * committing, so nothing flashes.
 */
export function useScopedNotice<T>(
  scope: string,
): [T | null, (notice: T | null) => void] {
  const [held, setHeld] = useState<{ notice: T; scope: string } | null>(null)

  // The scope has moved on: the notice described a state that no longer holds, so it is
  // dropped for good rather than merely hidden (see the doc above on resurrection).
  if (held !== null && held.scope !== scope) setHeld(null)

  // Guarded rather than a bare `held?.notice`, so the discarded pass above renders the
  // right thing too: the notice is shown only against the scope it was stamped with.
  const shown = held !== null && held.scope === scope ? held.notice : null

  const set = (notice: T | null) =>
    setHeld(notice === null ? null : { notice, scope })

  return [shown, set]
}
