import type { CareerCardDisplayProps } from './career-card-display'
import {
  buildCareerTileView,
  buildGamesWonTileView,
} from './career-card-display/career-tile.factory'
import {
  buildEmptyWinRateRingView,
  buildWinRateRingView,
} from './career-card-display/win-rate-ring.factory'
import type { CareerView } from './career-card-query'

/**
 * A career of 35 decided matches across two leagues — 24 W · 11 L, a 68.6% win
 * rate, and a two-win streak running.
 *
 * The total says **35 decided**, deliberately not the 50 the Recent-matches card
 * beside it links to: `match_total` counts the matches still in play too
 * (ADR-0915).
 */
export function buildCareerView(
  overrides: Partial<CareerView> = {},
): CareerView {
  return {
    ring: buildWinRateRingView(),
    record: '24 W · 11 L',
    streak: { label: 'On a 2-win streak', tone: 'win' },
    tiles: [buildCareerTileView(), buildGamesWonTileView()],
    total: '35 decided · 2 leagues',
    ...overrides,
  }
}

/**
 * A player who has decided nothing: no win rate, no games-won share, no streak
 * — all em dashes, and **never** a "0%", which would say they lose every match
 * they play.
 */
export function buildEmptyCareerView(
  overrides: Partial<CareerView> = {},
): CareerView {
  return buildCareerView({
    ring: buildEmptyWinRateRingView(),
    record: '0 W · 0 L',
    streak: null,
    tiles: [
      buildCareerTileView({ value: '—' }),
      buildGamesWonTileView({ value: '—' }),
    ],
    total: '0 decided · 1 league',
    ...overrides,
  })
}

/** Props for `CareerCardDisplay`. */
export function buildCareerCardDisplayProps(
  overrides: Partial<CareerCardDisplayProps> = {},
): CareerCardDisplayProps {
  return { career: buildCareerView(), ...overrides }
}
