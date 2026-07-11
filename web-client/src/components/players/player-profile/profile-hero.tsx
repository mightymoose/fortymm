import { Suspense } from 'react'

import { ProfileHeroFetcher } from './profile-hero/profile-hero-fetcher'
import { ProfileHeroSkeleton } from './profile-hero/profile-hero-skeleton'

export interface ProfileHeroProps {
  playerId: string
}

/**
 * The hero's identity card — avatar, username, member-since.
 *
 * Owns a `<Suspense>` with a hand-mirrored skeleton, and deliberately **no**
 * error boundary: every card on the profile projects off the same bundle query,
 * so a failure means none of them has anything to draw and it belongs to the
 * route's `PlayerRouteError` (the match-details contract).
 */
export function ProfileHero({ playerId }: ProfileHeroProps) {
  return (
    <Suspense fallback={<ProfileHeroSkeleton />}>
      <ProfileHeroFetcher playerId={playerId} />
    </Suspense>
  )
}
