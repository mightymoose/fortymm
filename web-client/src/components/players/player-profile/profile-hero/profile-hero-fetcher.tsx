import { useSuspenseQuery } from '@tanstack/react-query'

import { ProfileHeroDisplay } from './profile-hero-fetcher/profile-hero-display'
import { profileHeroQuery } from './profile-hero-fetcher/profile-hero-query'

export interface ProfileHeroFetcherProps {
  playerId: string
  /** The ladder this card's numbers are about (ADR-0915), from the profile's
   * `?league=`. `undefined` is the **default league** — the URL carries no param
   * for it. It is part of the bundle's query key, so every card on the page must
   * be handed the same one or the profile forks into two requests. */
  leagueId?: string
}

/** Thin fetcher: reads the hero's view off the profile bundle's shared cache
 * entry and hands it to the display. No `isLoading` branching — the wrapper's
 * `<Suspense>` owns the pending state, and the bundle's `throwOnError` sends a
 * failure to the route's error boundary. */
export function ProfileHeroFetcher({ playerId, leagueId }: ProfileHeroFetcherProps) {
  const { data: hero } = useSuspenseQuery(profileHeroQuery(playerId, leagueId))

  return <ProfileHeroDisplay hero={hero} />
}
