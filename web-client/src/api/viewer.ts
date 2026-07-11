import { useSession } from './session'

/**
 * The **viewer** — the person looking at the page — as opposed to the player the
 * page is *about* (ADR-0915, "The player profile is viewer-aware").
 *
 * The two are the same person exactly when you are looking at your own profile,
 * and the whole page's voice turns on that one comparison: the confidence card
 * says "where **you** stand" or "where **they** stand"; the head-to-head card
 * leads with your record against them, or degrades to their frequent opponents
 * because you cannot play yourself.
 *
 * It lives here, next to `useSession`, rather than inline in a card, because
 * more than one card asks the question and they must all answer it the same way.
 */

/**
 * The signed-in caller's own player id.
 *
 * `null` while the session is still loading, or if it failed — every caller of
 * `/v1/session` gets an id back (a guest is a real player with a real id), so a
 * `null` here means "we don't know yet", never "you are nobody".
 */
export function useViewerId(): string | null {
  const { data } = useSession()
  return data?.data.user.id ?? null
}

/**
 * True when `playerId` is the person *looking* — i.e. this is their own profile.
 *
 * Deliberately **false while the session is in flight**: the profile bundle is a
 * suspense query and the session is not, so a card can paint before we know who
 * is watching. Third person is the safe default to be caught in — "where they
 * stand" on your own profile for a frame is a wobble; "where you stand" on a
 * stranger's is a lie. In practice the app shell has the session cached long
 * before anyone reaches a profile, so this resolves before first paint.
 */
export function useIsViewer(playerId: string): boolean {
  const viewerId = useViewerId()
  return viewerId != null && viewerId === playerId
}
