import { CareerCard } from '@/components/players/player-profile/career-card'
import { ProfileHero } from '@/components/players/player-profile/profile-hero'
import { RatingPanel } from '@/components/players/player-profile/rating-panel'
import { RecentMatches } from '@/components/players/player-profile/recent-matches'

import './player-profile.css'

/**
 * The player profile at `/players/$userId` — an *overview* (ADR-0915).
 *
 * The composition root takes a **player id and nothing else**: each card below
 * fetches for itself, projecting off the profile bundle's single cache entry
 * (`playerByIdQueryOptions` + a `select` per card), so the page paints from ONE
 * request and each card suspends independently behind its own skeleton. This is
 * the match-details pattern; the route no longer threads a `player` object — or
 * a page number — through.
 *
 * The page is a normal scrolling document — it used to be a fixed-height pane
 * with an independently-scrolling table, which the overview has no use for.
 *
 * The matches section is the six-row **Recent matches** card, projected off that
 * same bundle: the profile is an overview, so the full paginated history lives
 * at its own route (`/players/$userId/matches`), which the card's
 * "View all N matches" link opens.
 *
 * The **Career** card projects off the same bundle again — but off its *career*
 * block, which is cross-league (ADR-0915). Two consequences that look like bugs
 * and are not: its total ("47 decided") is a *smaller* number than the Recent-
 * matches card's "View all 50 matches" right below it, because the history counts
 * the matches still in play; and it will not move when the league switcher does.
 */
export interface PlayerProfileProps {
  /** Route path param. Known before any query resolves, so the cards can start
   * fetching immediately. */
  playerId: string
}

export function PlayerProfile({ playerId }: PlayerProfileProps) {
  return (
    <div className="player-profile dark fortymm-theme">
      <header className="player-profile__hero">
        <div className="player-profile__hero-row">
          <ProfileHero playerId={playerId} />
          <RatingPanel playerId={playerId} />
        </div>
      </header>
      <div className="player-profile__body">
        <CareerCard playerId={playerId} />
        <RecentMatches playerId={playerId} />
      </div>
    </div>
  )
}
