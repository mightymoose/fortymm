import type { components } from '@/api/schema'

import {
  buildEmptyCareer,
  buildPlayerCareer,
  buildPlayerStreak,
} from './player-career.factory'
import {
  buildEmptyHeadToHead,
  buildHeadToHeadOpponent,
  buildHeadToHeadRecord,
  buildNeverMetHeadToHead,
  buildPlayerHeadToHead,
  buildSelfHeadToHead,
  buildViewerHeadToHead,
} from './head-to-head.factory'
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
import {
  FORTYMM_LEAGUE_ID,
  USATT_LEAGUE_ID,
  buildDefaultLeague,
  buildPlayerLeague,
  buildSecondLeague,
  buildUnratedLeague,
} from './player-league.factory'
import { buildRatingChange } from './rating-change.factory'
import {
  buildFirmingUpConfidence,
  buildProvisionalConfidence,
  buildRatingConfidence,
} from './rating-confidence.factory'

type PlayerDetail = components['schemas']['PlayerDetail']

// Re-exported so the profile's fixtures keep one import site: `rating_delta` on
// the bundle and `rating_change` on a match row are the same wire type, and the
// career, confidence and leagues blocks are only ever built to sit on a bundle.
export {
  buildRatingChange,
  buildPlayerCareer,
  buildEmptyCareer,
  buildPlayerStreak,
  buildRatingConfidence,
  buildProvisionalConfidence,
  buildFirmingUpConfidence,
  buildPlayerLeague,
  buildDefaultLeague,
  buildSecondLeague,
  buildUnratedLeague,
  buildPlayerHeadToHead,
  buildSelfHeadToHead,
  buildEmptyHeadToHead,
  buildViewerHeadToHead,
  buildNeverMetHeadToHead,
  buildHeadToHeadRecord,
  buildHeadToHeadOpponent,
  FORTYMM_LEAGUE_ID,
  USATT_LEAGUE_ID,
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
 *
 * `confidence` is **settled**, with an interval (1551–1823) that follows from
 * the rating (1687) and the deviation (69.4). It rides on the bundle because a
 * rating without a confidence is not a thing the API sends — only an *unrated*
 * player has none (see `buildUnratedPlayerDetail`).
 *
 * `leagues` carries **two** rows — FortyMM (the default, 1687) and USATT (1642)
 * — so the Leagues card, which is the page's league *switcher* (ADR-0915), is
 * actually exercisable. Two invariants the fixture holds on purpose, because a
 * fixture that breaks them lets a broken switcher pass:
 *
 * - the **default** league's rating equals the bundle's top-level `rating`; the
 *   hero and the card's default row are two views of the same fact, and the
 *   bundle *is* the default league's bundle unless a `?league=` said otherwise;
 * - the two ratings **differ** (1687 vs 1642) — if they matched, a switcher that
 *   never rebound the rating half of the page would look correct.
 *
 * And `leagues.length` matches `career.league_count` (2), exactly as the API
 * guarantees (both are counted off league *memberships*): the Leagues card and
 * the Career card's "· 2 leagues" sit on the same page and must not disagree.
 *
 * `head_to_head` is the one **viewer-aware** block (ADR-0915), and this default is
 * the bundle a *stranger* gets: a `versus_viewer` record of **1–4** — the viewer's
 * own, and lopsided on purpose, so a card that read it from the player's side
 * would print "4–1" and be caught — plus the player's three most-met opponents.
 * For the other two viewers, see `buildSelfHeadToHead` (you, looking at yourself:
 * no record, no self-challenge) and `buildNeverMetHeadToHead` (a guest, who has
 * played nobody — the common case, not an edge one).
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
    confidence: buildRatingConfidence(),
    match_total: 38,
    career: buildPlayerCareer(),
    leagues: [buildDefaultLeague(), buildSecondLeague()],
    head_to_head: buildPlayerHeadToHead(),
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
 * No rating also means **no confidence**: confidence says how settled a rating
 * is, so for a player who has none there is nothing to be confident *about* and
 * the API sends `null`. The profile's confidence card must not render at all for
 * them — a range like "somewhere between 1551 and 1823" around a rating that
 * does not exist would be nonsense.
 *
 * A career, though, they do have, for the same reason form survives: it counts
 * decided matches whatever their rating (a career has no rating at all). Theirs
 * is the one unrated win of their two matches — the other is still live, which is
 * why `decided` (1) is smaller than `match_total` (2).
 *
 * And they are in exactly **one** league — the default one every player is joined
 * to on sign-up (`CONTEXT.md` § *Default league*) — with a `null` rating on it,
 * since belonging to a ladder and holding a rating on it are different facts. So
 * `leagues.length` is 1 and `career.league_count` is 1: this is the shape of
 * every real user today, and the Leagues card must still render for them, as a
 * single row.
 *
 * Their `head_to_head` is kept honest against that one decided match: the viewer
 * has **never met** them (so the profile shows the invitation and the
 * Start-a-match CTA), and their single meeting is their one frequent opponent.
 * Note the head-to-head is orthogonal to the *rating* — a meeting is a decided
 * match, rated or not — so an unrated player very much has one, unlike confidence.
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
    confidence: null,
    leagues: [buildDefaultLeague({ rating: null })],
    head_to_head: buildPlayerHeadToHead({
      versus_viewer: buildNeverMetHeadToHead({
        opponent: buildHeadToHeadOpponent({ id: 'p-2', username: 'park.j' }),
      }),
      frequent_opponents: [
        buildHeadToHeadRecord({
          opponent: buildHeadToHeadOpponent({ id: 'p-21', username: 'nia.brandt' }),
          wins: 1,
          losses: 0,
        }),
      ],
    }),
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
