import { playerByIdQueryOptions, type PlayerDetail, type RatingRange } from '@/api/players'

/** The six cards below the hero, in no particular order — the order is what this
 * module decides. */
export type ProfileCardKey =
  | 'head-to-head'
  | 'recent-matches'
  | 'career'
  | 'rating-chart'
  | 'confidence'
  | 'leagues'

/**
 * Is the viewer looking at **their own** profile?
 *
 * Read from the **payload**, never from the session (ADR-0915). The API omits
 * `versus_viewer` exactly when the caller *is* the player — there is no record
 * against yourself — so the bundle already carries the answer, decided by the only
 * party who can be right about it.
 *
 * The session cannot be used for this, and the difference is not academic: the
 * bundle suspends and the session does not, so a component branching on
 * `useIsViewer` renders its first frames with the session's default (`false`) and
 * flashes the *other* viewer's shape before correcting itself. The head-to-head
 * card learned this first; the page's card **order** now depends on the same bit,
 * so it reads it the same way.
 *
 * Optional *and* nullable on the wire, hence `== null`: both spellings of "absent"
 * mean the same thing here.
 */
export const isOwnProfile = (player: PlayerDetail): boolean =>
  player.head_to_head.versus_viewer == null

/**
 * The order the six cards are rendered in, and it is **viewer-dependent**
 * (ADR-0915; `docs/designs/player-details.md` § *Mobile*).
 *
 * The page is a single column at every width, so this is DOM order — which means
 * it is also reading order, tab order and screen-reader order, all three of which
 * would disagree with the eye if this were done with CSS `order:` instead.
 *
 * On a phone only the first screen and a half get read, and on **someone else's**
 * profile that real estate belongs to "am I going to beat this person, and shall
 * we play right now?" — so head-to-head (your record against them, and the
 * Start-a-match CTA when you have never met) sits directly under the hero, and a
 * 90-day rating chart does not. A **guest** arriving on a shared link is always in
 * that never-met state, which makes this the app's best conversion moment.
 *
 * On **your own** profile there is no head-to-head to lead with — you cannot play
 * yourself — and what you came for is the win-rate ring, so Career leads and your
 * frequent opponents sink to the bottom.
 */
const OWN_PROFILE_ORDER: readonly ProfileCardKey[] = [
  'career',
  'rating-chart',
  'recent-matches',
  'confidence',
  'leagues',
  'head-to-head',
]

const OTHER_PROFILE_ORDER: readonly ProfileCardKey[] = [
  'head-to-head',
  'recent-matches',
  'career',
  'rating-chart',
  'confidence',
  'leagues',
]

/**
 * `undefined` — the bundle has not landed yet — takes **someone else's** order.
 *
 * It is the right default twice over: it is the overwhelmingly common visit (you
 * open other people's profiles, not your own), and it is what every guest on a
 * shared link sees, so the common cold load never reshuffles. Your own profile's
 * cold load does reshuffle once, while every card is still a skeleton — a skeleton
 * moving, not a card rendering the wrong shape, which is the thing ADR-0915 rules
 * out.
 */
export const profileCardOrder = (
  isOwn: boolean | undefined,
): readonly ProfileCardKey[] =>
  isOwn ? OWN_PROFILE_ORDER : OTHER_PROFILE_ORDER

/**
 * The composition root's projection off the profile bundle: one boolean, off the
 * **same cache entry** every card reads (same key, same fetch — a `select` that
 * narrows to a boolean also means the root re-renders only when that bit flips,
 * not on every field of the bundle).
 *
 * Deliberately **not** a suspense query: the root suspending would take the whole
 * page down to one fallback and throw away the per-card skeletons the profile is
 * built out of. It renders with `data: undefined` until the bundle lands, which is
 * exactly what `profileCardOrder` above is defaulting for.
 *
 * `leagueId` and `range` ride along for the same reason every card threads them:
 * they are part of the bundle's key (`leagueId`) and its request (`range`), so a
 * caller that dropped one would fork the page into a second request.
 */
export const profileOrderQuery = (
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) => ({
  ...playerByIdQueryOptions(playerId, leagueId, range),
  select: isOwnProfile,
})
