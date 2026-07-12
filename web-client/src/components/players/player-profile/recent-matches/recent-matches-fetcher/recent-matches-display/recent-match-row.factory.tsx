import type {
  RecentMatchDeltaView,
  RecentMatchGameView,
  RecentMatchRowView,
  RecentMatchStatusView,
} from '../recent-matches-query'
import type { RecentMatchRowProps } from './recent-match-row'

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
    opponent: 'ada.lovelace',
    isSolo: false,
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

/** Props for `RecentMatchRow`. */
export function buildRecentMatchRowProps(
  overrides: Partial<RecentMatchRowProps> = {},
): RecentMatchRowProps {
  return { row: buildRecentMatchRowView(), ...overrides }
}
