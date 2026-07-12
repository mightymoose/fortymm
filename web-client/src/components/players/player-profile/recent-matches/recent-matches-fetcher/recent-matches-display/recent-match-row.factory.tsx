import {
  NO_OPPONENT,
  type RecentMatchDeltaView,
  type RecentMatchGameView,
  type RecentMatchOpponentView,
  type RecentMatchRowView,
  type RecentMatchStatusView,
} from '../recent-matches-query'
import type { RecentMatchRowProps } from './recent-match-row'

/** A real opponent: a player with an id, so the row links to their profile. */
export function buildRecentMatchOpponentView(
  overrides: Partial<Extract<RecentMatchOpponentView, { kind: 'player' }>> = {},
): RecentMatchOpponentView {
  return { kind: 'player', id: 'p-9', name: 'ada.lovelace', ...overrides }
}

/** The **solo** opponent — the player-less sentinel side (ADR-0008). It carries
 * no id, because there is no player behind it: the row must print "No opponent"
 * as plain text rather than link to `/players/null`. */
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
  return {
    id: 'm-1',
    opponent: buildRecentMatchOpponentView(),
    status: buildRecentMatchStatusView(),
    score: {
      kind: 'games',
      games: [
        buildRecentMatchGameView({ mine: 11, theirs: 7, won: true }),
        buildRecentMatchGameView({ mine: 9, theirs: 11, won: false }),
        buildRecentMatchGameView({ mine: 11, theirs: 6, won: true }),
      ],
    },
    delta: buildRecentMatchDeltaView(),
    when: 'Mar 14',
    ...overrides,
  }
}

/** A match still in play: a live dot, "Live" where the score would go, and no
 * rating change to report. */
export function buildLiveRecentMatchRowView(
  overrides: Partial<RecentMatchRowView> = {},
): RecentMatchRowView {
  return buildRecentMatchRowView({
    id: 'm-live',
    status: buildRecentMatchStatusView({ tone: 'live', label: 'Live' }),
    score: { kind: 'text', text: 'Live' },
    delta: null,
    ...overrides,
  })
}

/**
 * A **solo** match: nobody on the other side, so the row reads "No opponent" and
 * has nothing to link to. The row is kept in the list, not dropped (ADR-0008).
 */
export function buildSoloRecentMatchRowView(
  overrides: Partial<RecentMatchRowView> = {},
): RecentMatchRowView {
  return buildRecentMatchRowView({
    id: 'm-solo',
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
