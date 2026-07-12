import { matchDetailRoute } from '@/api/matches'
import { matchRowAriaLabel } from '@/components/matches/match-row-link/match-row-naming'

import {
  NO_OPPONENT,
  type RecentMatchDeltaView,
  type RecentMatchGameView,
  type RecentMatchOpponentView,
  type RecentMatchRowView,
  type RecentMatchStatusView,
} from '../recent-matches-query'
import type { RecentMatchRowProps } from './recent-match-row'

/** A real match id — a **UUID**, the way the API emits them and the way the
 * `$matchId` route guard (`src/lib/match-id.ts`) demands. The row's link is
 * asserted by its `href`, so the id it is built from has to be a plausible one. */
export const RECENT_MATCH_ID = '7d1c9e52-3a64-4b18-9f0e-2c7b5a48d631'

/** The href that id must produce. */
export const RECENT_MATCH_HREF = `/matches/${RECENT_MATCH_ID}`

/** A real opponent: a player with an id, so the row links to their profile. */
export function buildRecentMatchOpponentView(
  overrides: Partial<Extract<RecentMatchOpponentView, { kind: 'player' }>> = {},
): RecentMatchOpponentView {
  return { kind: 'player', id: 'p-9', name: 'ada.lovelace', ...overrides }
}

/** The **solo** opponent — the player-less sentinel side (ADR-0008). It carries
 * no id, because there is no player behind it: the row must print "No opponent"
 * as plain text rather than link to `/players/null`. (The *row* still links to
 * the match — a solo match is a match.) */
export function buildSoloOpponentView(): RecentMatchOpponentView {
  return { kind: 'solo', name: NO_OPPONENT }
}

export function buildRecentMatchGameView(
  overrides: Partial<RecentMatchGameView> = {},
): RecentMatchGameView {
  return { mine: 11, theirs: 7, won: true, ...overrides }
}

export function buildRecentMatchStatusView(
  overrides: Partial<RecentMatchStatusView> = {},
): RecentMatchStatusView {
  return { tone: 'won', label: 'Won', ...overrides }
}

/** A rating gain from a decided, rated match. */
export function buildRecentMatchDeltaView(
  overrides: Partial<RecentMatchDeltaView> = {},
): RecentMatchDeltaView {
  return {
    label: '+12',
    ariaLabel: 'Gained 12 rating',
    tone: 'win',
    ...overrides,
  }
}

/** A decided, rated **win**: a green dot, three game chips and a +12. Every
 * other state on this all-inclusive list is a named variant below. */
export function buildRecentMatchRowView(
  overrides: Partial<RecentMatchRowView> = {},
): RecentMatchRowView {
  const row = {
    id: RECENT_MATCH_ID,
    opponent: buildRecentMatchOpponentView(),
    status: buildRecentMatchStatusView(),
    score: {
      kind: 'games',
      games: [
        buildRecentMatchGameView({ mine: 11, theirs: 7, won: true }),
        buildRecentMatchGameView({ mine: 9, theirs: 11, won: false }),
        buildRecentMatchGameView({ mine: 11, theirs: 6, won: true }),
      ],
    } satisfies RecentMatchRowView['score'],
    delta: buildRecentMatchDeltaView(),
    when: 'Mar 14',
    ...overrides,
  }
  return {
    ...row,
    // Derived off the *merged* row, exactly as `selectRow` derives them off the
    // wire row: override the id, the opponent or the day and the link follows.
    // A factory that let the two drift could hand a test a row whose label says
    // "Mar 14" and whose href points at somebody else's match.
    detailRoute: overrides.detailRoute ?? matchDetailRoute(row.id),
    ariaLabel:
      overrides.ariaLabel ??
      matchRowAriaLabel({
        opponent: row.opponent.name,
        isSolo: row.opponent.kind === 'solo',
        when: row.when,
      }),
  }
}

/** The live variant's own id — a different match, so a different href. */
export const LIVE_MATCH_ID = 'b4e07a19-8d52-4c63-a1f8-93e6c05d7284'

/** A match still in play: a live dot, "Live" where the score would go, and no
 * rating change to report. */
export function buildLiveRecentMatchRowView(
  overrides: Partial<RecentMatchRowView> = {},
): RecentMatchRowView {
  return buildRecentMatchRowView({
    id: LIVE_MATCH_ID,
    status: buildRecentMatchStatusView({ tone: 'live', label: 'Live' }),
    score: { kind: 'text', text: 'Live' },
    delta: null,
    ...overrides,
  })
}

/** The solo variant's own id — a different match again, and a UUID like the rest,
 * because its row link is asserted by `href` too. */
export const SOLO_MATCH_ID = 'c05f8d31-72ae-4b96-8d14-6f39a2e7b508'

/**
 * A **solo** match: nobody on the other side, so the opponent's name is not a link
 * — there is nobody to link *to*. The row is kept in the list, not dropped
 * (ADR-0008), and it still links to its match: a solo match is a match.
 */
export function buildSoloRecentMatchRowView(
  overrides: Partial<RecentMatchRowView> = {},
): RecentMatchRowView {
  return buildRecentMatchRowView({
    id: SOLO_MATCH_ID,
    opponent: buildSoloOpponentView(),
    ...overrides,
  })
}

/** Props for `RecentMatchRow`. */
export function buildRecentMatchRowProps(
  overrides: Partial<RecentMatchRowProps> = {},
): RecentMatchRowProps {
  return { row: buildRecentMatchRowView(), ...overrides }
}
