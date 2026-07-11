import { Suspense } from 'react'

import { ProfileHeroFetcher } from './profile-hero/profile-hero-fetcher'
import { ProfileHeroSkeleton } from './profile-hero/profile-hero-skeleton'

export interface ProfileHeroProps {
  playerId: string
  /** The ladder this card's numbers are about (ADR-0915), from the profile's
   * `?league=`. `undefined` is the **default league** — the URL carries no param
   * for it. It is part of the bundle's query key, so every card on the page must
   * be handed the same one or the profile forks into two requests. */
  leagueId?: string
}

/**
 * The hero's identity card — avatar, username, member-since.
 *
 * Owns a `<Suspense>` with a hand-mirrored skeleton, and deliberately **no**
 * error boundary: every card on the profile projects off the same bundle query,
 * so a failure means none of them has anything to draw and it belongs to the
 * route's `PlayerRouteError` (the match-details contract).
 */
export function ProfileHero({ playerId, leagueId }: ProfileHeroProps) {
  return (
    <Suspense fallback={<ProfileHeroSkeleton />}>
      <ProfileHeroFetcher playerId={playerId} leagueId={leagueId} />
    </Suspense>
  )
}
