/** What a history row needs in order to name its match for a screen reader. */
export interface MatchRowLinkNaming {
  /** The opponent's display name, or "No opponent" for a solo match. */
  opponent: string
  /** True for the player-less solo sentinel side (ADR-0008). */
  isSolo: boolean
  /** The row's date, as rendered, e.g. "Mar 14". */
  when: string
}

/**
 * The accessible name of a match-history row's link. It names the **match**, not
 * a person: "Match against ada.lovelace, Mar 14".
 *
 * This is why the anchor sits on the date cell rather than around the opponent's
 * name — "ada.lovelace", announced as a link, promises a *profile* and delivers a
 * match. Naming the destination is the label's whole job (#989).
 *
 * A solo match has no opponent to be "against" (its second side is the
 * player-less sentinel, ADR-0008), so it reads "Solo match, Mar 14".
 *
 * Lives beside `MatchRowLink` rather than inside it because both surfaces derive
 * this label **before** the component — the profile card in its `select`, the
 * history page in its row — so it must be importable without importing a
 * component.
 */
export function matchRowAriaLabel({
  opponent,
  isSolo,
  when,
}: MatchRowLinkNaming): string {
  return isSolo ? `Solo match, ${when}` : `Match against ${opponent}, ${when}`
}
