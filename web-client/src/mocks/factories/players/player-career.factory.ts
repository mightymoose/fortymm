import type { components } from '@/api/schema'

type PlayerCareer = components['schemas']['PlayerCareer']
type PlayerStreak = components['schemas']['PlayerStreak']

/**
 * A run of consecutive same-outcome decided matches. Never zero-length — the
 * absence of a streak is the *field* being `null`, not an `n: 0`
 * (`CONTEXT.md` § *Streak*).
 */
export function buildPlayerStreak(
  overrides: Partial<PlayerStreak> = {},
): PlayerStreak {
  return { kind: 'W', n: 2, ...overrides }
}

/**
 * The profile bundle's **cross-league** career block (`CONTEXT.md` § *Career*;
 * ADR-0915). A fact about the *person*, not about a ladder: it deliberately
 * ignores the league the profile was asked for.
 *
 * Two things the numbers here encode on purpose, because the card must not undo
 * them:
 *
 * - `win_rate` and `games_won_pct` are **shares in [0, 1]**, despite the names —
 *   `0.375` is *37.5%*, not 0.375%. The client formats them.
 * - `decided` counts only *decided* matches, so it is deliberately **smaller**
 *   than `PlayerDetail.match_total`, which counts the all-inclusive history
 *   (matches still in play included). The default bundle pairs `decided: 35`
 *   with `match_total: 38`; reconciling the two is the bug ADR-0915 warns about.
 */
export function buildPlayerCareer(
  overrides: Partial<PlayerCareer> = {},
): PlayerCareer {
  return {
    // 24 + 11 — the same record `buildPlayerDetail` carries, and three fewer
    // than its all-inclusive `match_total` of 38.
    decided: 35,
    wins: 24,
    losses: 11,
    // A share, not a percentage: 24/35 → the card must read "68.6%".
    win_rate: 24 / 35,
    // 0.582 → "58.2%". Games won is a finer read than wins and losses: a 3–2
    // win and a 3–0 win are the same in the W–L column and very different here.
    games_won_pct: 0.582,
    current_streak: buildPlayerStreak({ kind: 'W', n: 2 }),
    best_streak: buildPlayerStreak({ kind: 'W', n: 7 }),
    league_count: 2,
    ...overrides,
  }
}

/**
 * A player who has decided nothing yet: the shares are **`null`, not `0`**, and
 * so are both streaks. A zero would claim they lose every match they play — the
 * card must render an em dash here, never "0%".
 *
 * Distinct from a player who has decided matches and *lost them all* — that
 * player has `win_rate: 0`, which is a real 0% and must render as one. Build
 * that one with `buildPlayerCareer({ decided: n, wins: 0, ..., win_rate: 0 })`.
 */
export function buildEmptyCareer(
  overrides: Partial<PlayerCareer> = {},
): PlayerCareer {
  return buildPlayerCareer({
    decided: 0,
    wins: 0,
    losses: 0,
    win_rate: null,
    games_won_pct: null,
    current_streak: null,
    best_streak: null,
    league_count: 1,
    ...overrides,
  })
}
