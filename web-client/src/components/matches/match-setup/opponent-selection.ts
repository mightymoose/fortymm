import type { Opponent } from './opponent'

/**
 * Who the match-setup form is being set up against: one value, three
 * mutually-exclusive cases (`DEFINITION_OF_COMPLETE.md` — non-fetch view state
 * with mutually exclusive cases is a sum type, the client-side twin of "no
 * tri-state booleans").
 *
 * The case that didn't exist before (#893) is **`seeking`**. When
 * `Opponent | null` was the whole model, "I typed a name and found nobody" and
 * "I want a solo match" were *the same value* — `null` — so a user still
 * hunting for an opponent was told "Ready: You · solo match" and Start match
 * created a solo match they never asked for. The card structurally could not
 * tell the two apart. Splitting the `null` in two is what lets it.
 *
 * `seeking` is a **non-empty**, uncommitted query. An empty search box is
 * `none`, not `seeking`: merely opening the search must not nag the user or
 * relabel the button — with nothing typed, solo is still the honest default.
 */
export type OpponentSelection =
  | { kind: 'none' }
  | { kind: 'seeking' }
  | { kind: 'picked'; opponent: Opponent }

/**
 * Resolve the selection from the two things the card can observe: the opponent
 * it has committed to (picked, or preseeded from `?opponent=`), and whether the
 * picker currently holds an uncommitted search.
 *
 * A committed opponent always wins: once you've picked someone, whatever is
 * left in the search box is irrelevant.
 *
 * `seeking` carries no payload on purpose. It is the *fact* of an unresolved
 * search, not its text — and taking the boolean rather than the string is what
 * keeps the card off the keystroke path: mirroring the query up re-rendered the
 * whole form on every character and re-registered the `useBlocker` guard with
 * it, to fill a field nothing ever read.
 */
export function opponentSelection(
  opponent: Opponent | null,
  isSeeking: boolean,
): OpponentSelection {
  if (opponent !== null) return { kind: 'picked', opponent }
  return isSeeking ? { kind: 'seeking' } : { kind: 'none' }
}

/**
 * The opponent the match will actually be created against — `null` for
 * `seeking` exactly as for `none`, because an uncommitted query is not an
 * opponent.
 *
 * Every "unrated unless there's an opponent" rule reads through this one
 * accessor (the rated field, the summary line, the submit payload), so the
 * places that enforce it cannot drift apart on what `seeking` means: a seeking
 * match is unrated and solo, just like `none`.
 */
export function selectedOpponent(selection: OpponentSelection): Opponent | null {
  return selection.kind === 'picked' ? selection.opponent : null
}

/** Rating needs a *committed* opponent — a `seeking` match can't be rated. */
export function isRatable(selection: OpponentSelection): boolean {
  return selection.kind === 'picked'
}
