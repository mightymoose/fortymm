import type { components } from '@/api/schema'

import {
  buildEmptyCareer,
  buildPlayerCareer,
  buildPlayerStreak,
} from './player-career.factory'
import {
  buildAwaitingMatchRow,
  buildLiveMatchRow,
  buildLossMatchRow,
  buildPlayerMatchList,
  buildPlayerMatchRow,
  buildSoloMatchRow,
  buildUnratedWinMatchRow,
  buildVoidedMatchRow,
} from './player-match-row.factory'
import { buildRatingChange } from './rating-change.factory'

type PlayerDetail = components['schemas']['PlayerDetail']

// Re-exported so the profile's fixtures keep one import site: `rating_delta` on
// the bundle and `rating_change` on a match row are the same wire type, and the
// career block is only ever built to sit on a bundle.
export {
  buildRatingChange,
  buildPlayerCareer,
  buildEmptyCareer,
  buildPlayerStreak,
}

/**
 * The profile BFF bundle (`GET /v1/players/{id}`). Defaults to a rated player
 * with a full standing: a rank on a 42-strong ladder, a peak, a recent rating
 * move and ten results of form.
 *
 * The embedded `matches` are the **six most recent** — deliberately mixed, since
 * that list is all-inclusive (ADR-0008): a live match, one awaiting acceptance,
 * a voided one and a solo one sit alongside the decided ones. And `match_total`
 * (38) is deliberately **larger** than the decided count (24 + 11 = 35): the
 * three matches in play are in the history but not in the record. Reconciling
 * those two numbers is the bug ADR-0915 warns about.
 *
 * `percentile` defaults to `null`, as the real API sends it below its
 * minimum-rated-population threshold — pass one explicitly to exercise the
 * "Top N%" branch.
 *
 * `career` is **cross-league** (ADR-0915) and counts only decided matches, so
 * `career.decided` (35) is deliberately smaller than `match_total` (38) — the
 * two numbers sit on the same page and differ on purpose.
 */
export function buildPlayerDetail(
  overrides: Partial<PlayerDetail> = {},
): PlayerDetail {
  return {
    id: 'p-1',
    username: 'rita.kovac',
    rating: 1687,
    rank: 3,
    wins: 24,
    losses: 11,
    form: 'WWLWLLWWLW',
    member_since: '2024-03-14T09:00:00Z',
    rating_delta: buildRatingChange(),
    peak: 1712,
    rank_of: 42,
    percentile: null,
    match_total: 38,
    career: buildPlayerCareer(),
    matches: buildPlayerMatchList([
      buildLiveMatchRow({ opponent: { id: 'p-8', username: 'kai.zhou' } }),
      buildAwaitingMatchRow({ opponent: { id: 'p-7', username: 'lin.wu' } }),
      buildPlayerMatchRow(),
      buildLossMatchRow({ opponent: { id: 'p-6', username: 'grace.hopper' } }),
      buildVoidedMatchRow({ opponent: { id: 'p-5', username: 'joe.bell' } }),
      buildSoloMatchRow(),
    ]),
    ...overrides,
  }
}

/**
 * A player who has never finished a rated match. No rating means no rank — and
 * so no ladder position, no peak, no percentile and no rating delta
 * (`CONTEXT.md` § *Rank*). They may still have *form*: form counts decided
 * matches, rated or not — and matches, whose rows moved no rating, so every one
 * of them reads a `—` rather than a "+0".
 *
 * A career too, for the same reason: it counts decided matches whatever their
 * rating (a career has no rating at all). Theirs is the one unrated win of their
 * two matches — the other is still live, which is why `decided` (1) is smaller
 * than `match_total` (2).
 */
export function buildUnratedPlayerDetail(
  overrides: Partial<PlayerDetail> = {},
): PlayerDetail {
  return buildPlayerDetail({
    id: 'p-2',
    username: 'park.j',
    rating: null,
    rank: null,
    rank_of: null,
    peak: null,
    percentile: null,
    rating_delta: null,
    matches: buildPlayerMatchList([
      buildUnratedWinMatchRow(),
      buildLiveMatchRow({ opponent: { id: 'p-8', username: 'kai.zhou' } }),
    ]),
    match_total: 2,
    career: buildPlayerCareer({
      decided: 1,
      wins: 1,
      losses: 0,
      win_rate: 1,
      games_won_pct: 0.6,
      current_streak: buildPlayerStreak({ kind: 'W', n: 1 }),
      best_streak: buildPlayerStreak({ kind: 'W', n: 1 }),
      league_count: 1,
    }),
    ...overrides,
  })
}
