import type { RatingHistoryWindow, RatingPoint } from '@/api/players'

/**
 * An ISO instant `days` days before *now*.
 *
 * Relative, never a hard-coded 2025 date, and that is load-bearing: the chart is
 * a **calendar** window (ADR-0915), so its x-axis runs from `now - range` to
 * `now`. A fixture pinned to an absolute date drifts out of the window as the
 * calendar moves and the fixture's points quietly stop being drawn — the chart
 * would go flat and every test asserting a line would still pass, having asserted
 * nothing.
 */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** One instant on the rating timeline: what the rating became, and when. */
export function buildRatingPoint(
  overrides: Partial<RatingPoint> = {},
): RatingPoint {
  return {
    at: daysAgo(30),
    rating: 1650,
    match_id: 'm-1',
    ...overrides,
  }
}

/**
 * The default 90-day window of a rated, improving player: they came into the
 * window at **1560** and leave it at **1687**, so `change` is **+127** — the
 * headline the ADR's example quotes.
 *
 * Three things the fixture holds on purpose, because a fixture that broke them
 * would let a broken chart pass:
 *
 * - the **anchor is dated OUTSIDE the window** (100 days ago, for a 90-day
 *   window). It is the player's rating *as of the window start*, read from their
 *   last match *before* it — that point is what makes "+127 over 90 days" true,
 *   and a chart that ignored it would start the line at 1602 (the first in-window
 *   match) and report +85;
 * - `change` is measured **from the anchor**, not from `points[0]`;
 * - the in-window `peak` (1701) is **not** the same number as the profile
 *   bundle's all-time `peak` (1712). They sit on the same page and neither may be
 *   read for the other.
 */
export function buildRatingHistoryWindow(
  overrides: Partial<RatingHistoryWindow> = {},
): RatingHistoryWindow {
  return {
    anchor: buildRatingPoint({ at: daysAgo(100), rating: 1560, match_id: 'm-0' }),
    points: [
      buildRatingPoint({ at: daysAgo(72), rating: 1602, match_id: 'm-1' }),
      buildRatingPoint({ at: daysAgo(55), rating: 1589, match_id: 'm-2' }),
      buildRatingPoint({ at: daysAgo(31), rating: 1701, match_id: 'm-3' }),
      buildRatingPoint({ at: daysAgo(9), rating: 1687, match_id: 'm-4' }),
    ],
    peak: buildRatingPoint({ at: daysAgo(31), rating: 1701, match_id: 'm-3' }),
    change: 127,
    ...overrides,
  }
}

/** A window the player LOST ground in — the "Down −43" branch. Nothing about the
 * card may hard-code a `+`. */
export function buildFallingRatingWindow(
  overrides: Partial<RatingHistoryWindow> = {},
): RatingHistoryWindow {
  return buildRatingHistoryWindow({
    anchor: buildRatingPoint({ at: daysAgo(100), rating: 1730, match_id: 'm-0' }),
    points: [
      buildRatingPoint({ at: daysAgo(60), rating: 1712, match_id: 'm-1' }),
      buildRatingPoint({ at: daysAgo(20), rating: 1687, match_id: 'm-2' }),
    ],
    peak: buildRatingPoint({ at: daysAgo(60), rating: 1712, match_id: 'm-1' }),
    change: -43,
    ...overrides,
  })
}

/**
 * A **rated player with nothing in the window** — the first-class empty state, not
 * an error (ADR-0915). They carry in an anchor (1687, from a match before the
 * window) and no points at all: the chart draws a **flat line at their current
 * rating**, says "No rated matches in the last 90 days", and suppresses the change
 * chip entirely.
 *
 * `change` is `null`, never `0`. A "+0" here would claim they played and moved
 * nothing, when in fact they did not play.
 */
export function buildEmptyRatingWindow(
  overrides: Partial<RatingHistoryWindow> = {},
): RatingHistoryWindow {
  return {
    anchor: buildRatingPoint({ at: daysAgo(140), rating: 1687, match_id: 'm-0' }),
    points: [],
    peak: null,
    change: null,
    ...overrides,
  }
}

/**
 * A player who has **never held a rating** on this ladder: no anchor to carry in,
 * no points, no peak, no change.
 *
 * The profile never asks for this window — an unrated player gets no chart at all,
 * the slot shows an "Unrated" panel instead (consistent with the hero and the
 * confidence card) — so it exists to pin exactly that: a chart card that rendered
 * an axis full of `NaN`s off this payload would be the bug.
 */
export function buildUnratedRatingWindow(
  overrides: Partial<RatingHistoryWindow> = {},
): RatingHistoryWindow {
  return {
    anchor: null,
    points: [],
    peak: null,
    change: null,
    ...overrides,
  }
}
