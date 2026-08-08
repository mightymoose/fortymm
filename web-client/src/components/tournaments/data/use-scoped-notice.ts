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
 * ## The stamp is the RECONCILED scope, not the one the click was made against
 *
 * A refusal is the **server's** judgement, made against the **server's** state — which is
 * not always what this client was showing when the director clicked. The refusals most
 * likely to differ are the ones that fired *because* of that gap: a draw gone stale under
 * an entry nobody here had seen, a draw already under way on another device. Their
 * mutations therefore reconcile before the `catch` runs (`reconcileTournament`, `./api`),
 * so by the time a notice is written this client has caught up — and the stamp has to be
 * that caught-up scope. Stamping the click's scope instead pinned the notice to a state
 * that was already gone, and the very next render dropped it: a flash, and no explanation.
 * That is the silent failure `drawRefusalNotice` and `lifecycleRefusalNotice` both exist
 * to make impossible.
 *
 * The stamp is taken by the **render the write schedules**, not by the setter and not by
 * an effect. A notice is written unbound, and the next render binds it to the scope it
 * reads. That render is caused by the write itself, so it sees the tournament as it
 * stands at that moment — after the reconciliation, because the reconciliation is what
 * the mutation awaited. No ref, and no dependence on when passive effects flush relative
 * to a promise continuation.
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
  // `scope: null` means **not bound yet** — written, but not yet stamped. It is a
  // one-render state: the render this `setHeld` schedules binds it below.
  const [held, setHeld] = useState<{ notice: T; scope: string | null } | null>(null)

  // Bind an unbound notice to the scope of the first render that sees it — which is a
  // render caused by `set` itself, and therefore one that reads the tournament as it
  // stands *now*. That is what makes the stamp the reconciled scope rather than the
  // click's, with no dependence on when effects happen to flush.
  if (held !== null && held.scope === null) setHeld({ ...held, scope })
  // The scope has moved on: the notice described a state that no longer holds, so it is
  // dropped for good rather than merely hidden (see the doc above on resurrection). This
  // is the ONLY thing that retires a stale notice — the read below deliberately does not
  // second-guess it. A guard there (`held.scope === scope ? … : null`) would be the exact
  // negation of this condition, so it could only ever fire in the pass this `setHeld` has
  // already condemned, and React never commits that pass or shows it to a child. It would
  // read as a second mechanism while doing no work.
  else if (held !== null && held.scope !== scope) setHeld(null)

  // Written **unbound**. The setter deliberately does not read `scope`: it runs from an
  // async `catch`, where the enclosing render's `scope` may predate the reconciliation
  // that made the refusal true (see the doc above).
  const set = (notice: T | null) =>
    setHeld(notice === null ? null : { notice, scope: null })

  return [held?.notice ?? null, set]
}
