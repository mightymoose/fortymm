// **The eight inputs, assembled once** (#1320): the bridge between an event draft as the
// editor holds it and `deriveDrawStructure`, which takes eight loose numbers and modes.
//
// Two callers need the same answer about the same draft, and they must not each assemble
// it. The **Draw structure tab** renders the whole derivation; the **editor's action bar**
// asks it one question — is this configuration impossible? — because a save must not send
// a draw that cannot be played (the reference's action bar, and ADR 20260808's "three
// refusals stay"). Assembled twice, the two would eventually disagree about which pool
// list or which field size they meant, and the button would block while the tab showed
// nothing wrong.
//
// It is a pure function over a draft. Nothing here fetches, renders or remembers.

import { everySettingAutomatic } from '../../../data/draw-ownership'
import {
  deriveDrawStructure,
  type DrawStructure,
  type ImpossibleProblem,
} from '../../../data/draw-structure'
import type { PoolEntry, TournamentEvent } from '../../../data/types'
import { previewFieldSize } from './preview-field'

/**
 * Derive the whole draw structure of an event **draft**.
 *
 * ⚠️ `pools` is the **form's** pool list, not `event.pools`. An event's pool count IS the
 * number of its pool rows (ADR
 * 20260808-an-events-pool-count-is-its-pool-rows-and-a-derived-count-is-a-projection), and
 * the list the director is editing is the one the derivation has to count — the draft's
 * `pools` field is the read model's `Pool[]` by type and the form's `PoolEntry[]` at
 * runtime (ADR 20260801), so it is passed separately in the shape that is honest.
 *
 * An event that has never seen the Draw structure tab stores no ownership record, and the
 * all-automatic one is what that means: "an event that sets nothing behaves exactly as it
 * does today" (ADR 20260808). A **fresh** record every call, never a shared constant.
 */
export function eventDrawStructure(
  event: TournamentEvent,
  pools: PoolEntry[],
): DrawStructure {
  const ownership = event.drawOwnership ?? everySettingAutomatic()
  return deriveDrawStructure({
    previewFieldSize: previewFieldSize(event.maxPlayers),
    poolReservationCount: pools.length,
    poolCountMode: ownership.poolCountMode,
    manualPoolCount: ownership.manualPoolCount,
    poolSizeMode: ownership.poolSizeMode,
    manualPoolSize: ownership.manualPoolSize,
    qualifiersMode: ownership.qualifiersMode,
    // **The event's own K is the manual slot.** There is no `manual_qualifiers` on the
    // wire, so it is passed unconditionally and the derivation's `qualifiersMode` check
    // decides whether anybody reads it.
    manualQualifiers: event.qualifiersPerPool,
  })
}

/**
 * The competition this draft **cannot play**, or `null`.
 *
 * This is the save gate (#1320's action bar): a pool of one, a knockout of one, or more
 * qualifiers than the smallest pool holds are impossible competitions, and the editor
 * refuses to send one. It returns the problem rather than a boolean because the disabled
 * button has to explain itself, and the only honest explanation is the derivation's own
 * words (ADR-0015 — a dead end with no reason is the thing to avoid).
 *
 * Three deliberate narrowings, each of which is the whole reason this lives here rather
 * than at the call site:
 *
 * - **`rr-then-ko` only.** No other draw type has a pool stage feeding a knockout, so no
 *   other draw type can be refused for the shape of one. A round-robin event saves.
 * - **`impossibleProblems` only.** A **disagreement** is not a refusal: six pools of five
 *   seat thirty, a field of forty does not fit, and the app keeps both numbers and saves
 *   (ADR 20260808 — "a disagreement is not a refusal"). Only the *cut* is unavailable.
 * - **No draft, no verdict.** The editor renders before it has an event to judge.
 */
export function impossibleDrawStructure(
  event: TournamentEvent | null,
  pools: PoolEntry[],
): ImpossibleProblem | null {
  if (event === null || event.drawType !== 'rr-then-ko') return null
  const [problem] = eventDrawStructure(event, pools).impossibleProblems
  return problem ?? null
}
