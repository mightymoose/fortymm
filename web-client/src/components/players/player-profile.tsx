import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import type { RatingRange } from '@/api/players'
import { CareerCard } from '@/components/players/player-profile/career-card'
import { ConfidenceCard } from '@/components/players/player-profile/confidence-card'
import { HeadToHeadCard } from '@/components/players/player-profile/head-to-head-card'
import { LeaguesCard } from '@/components/players/player-profile/leagues-card'
import {
  profileCardOrder,
  profileOrderQuery,
  type ProfileCardKey,
} from '@/components/players/player-profile/profile-order'
import { ProfileHero } from '@/components/players/player-profile/profile-hero'
import { RatingChart } from '@/components/players/player-profile/rating-chart'
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
 *
 * The **Rating confidence** card is the page's first *viewer-aware* surface
 * (ADR-0915): its copy is second person on your own profile and third person on
 * anyone else's. It is also the only card that can render **nothing** — a player
 * with no rating has no confidence — so it is mounted unconditionally and decides
 * for itself whether it exists.
 *
 * The **Leagues** card is the page's *switcher*, and the reason `leagueId` exists
 * (ADR-0915). Everything here splits in two along it:
 *
 * - the **rating half** — the hero's rating/rank/peak/Δ, the rating panel's form,
 *   the confidence card, and the Leagues card's own highlight — is scoped to one
 *   ladder, and rebinds when the selection changes;
 * - **Career** is cross-league and does not move. It is handed `leagueId` all the
 *   same, and that is deliberate: the league is part of the *bundle's* query key,
 *   so every card must be handed the same one or the page forks into two
 *   requests. Career's numbers are league-stable because the API says so, not
 *   because it opted out of the key.
 *
 * The **Head-to-head** card is where viewer-awareness stops being a matter of
 * pronouns and becomes structure (ADR-0915). On somebody else's profile it leads
 * with *your* record against them and, if you have never played them — which is
 * what every guest, i.e. everyone arriving on a shared link, has — offers to start
 * a match with them already picked. On your own it is simply "Frequent opponents":
 * there is no record against yourself, and no challenging yourself to a match.
 * Like Career it is cross-league (a meeting is a decided match on any ladder) and
 * takes `leagueId` anyway, for the same one-request reason.
 *
 * The **Rating chart** is the one card here that does *not* project off the bundle
 * (ADR-0915). Its range tabs must fetch **only** the range, so it owns a query
 * against `/rating-history` keyed on the range — and, because it does, it is also
 * the only card that can fail on its own and must therefore hold its own error
 * state. It still costs nothing on first paint: its cache is seeded from the
 * `rating_history` block the bundle already carries for the range the page loaded
 * with. Hence `range`, which every card is handed for the same one-request reason
 * `leagueId` is: it rides on the bundle's *request* (though not its key).
 *
 * Finally, the **order** those six cards come in is itself viewer-aware
 * (ADR-0915). The page is one column at every width, so it is stacked in DOM
 * order — the same order a phone reads top-to-bottom, a keyboard tabs through and
 * a screen reader announces, which a CSS `order:` would have silently split in
 * three. On somebody else's profile Head-to-head sits directly under the hero (on
 * a phone that is all the room there is, and it belongs to "shall we play right
 * now?"); on your own, Career does. See `profile-order.ts` — including why the bit
 * comes from the payload rather than the session.
 */
export interface PlayerProfileProps {
  /** Route path param. Known before any query resolves, so the cards can start
   * fetching immediately. */
  playerId: string
  /** The ladder the rating half of the page is bound to — the route's `?league=`
   * (ADR-0915). `undefined` is the **default league**, which is what a URL with
   * no param means. */
  leagueId?: string
  /** The calendar window the rating chart is drawn over — the route's `?range=`
   * (ADR-0915). `undefined` is the **default window** (90 days), which is what a
   * URL with no param means. */
  range?: RatingRange
}

export function PlayerProfile({
  playerId,
  leagueId,
  range,
}: PlayerProfileProps) {
  // Whose profile is this? One boolean, projected off the bundle every card
  // already reads — no session, no second request (`profile-order.ts`). It is
  // `undefined` until the bundle lands, which is the cold-load case the order
  // function defaults for.
  const { data: isOwn } = useQuery(
    profileOrderQuery(playerId, leagueId, range),
  )

  // Keyed, so a reorder MOVES each card rather than remounting it: the chart holds
  // its own query with `keepPreviousData`, and a remount would throw that buffer
  // away and re-suspend a card that already has its data.
  const cards: Record<ProfileCardKey, ReactNode> = {
    'head-to-head': (
      <HeadToHeadCard
        key="head-to-head"
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    ),
    'recent-matches': (
      <RecentMatches
        key="recent-matches"
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    ),
    career: (
      <CareerCard
        key="career"
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    ),
    'rating-chart': (
      <RatingChart
        key="rating-chart"
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    ),
    confidence: (
      <ConfidenceCard
        key="confidence"
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    ),
    leagues: (
      <LeaguesCard
        key="leagues"
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    ),
  }

  return (
    <div className="player-profile dark fortymm-theme">
      <header className="player-profile__hero">
        <div className="player-profile__hero-row">
          <ProfileHero playerId={playerId} leagueId={leagueId} range={range} />
          <RatingPanel playerId={playerId} leagueId={leagueId} range={range} />
        </div>
      </header>
      <div className="player-profile__body">
        {profileCardOrder(isOwn).map((key) => cards[key])}
      </div>
    </div>
  )
}
