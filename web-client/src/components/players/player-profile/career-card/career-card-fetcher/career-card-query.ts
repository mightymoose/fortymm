import { playerByIdQueryOptions, type PlayerDetail } from '@/api/players'
import type { components } from '@/api/schema'

type PlayerCareer = components['schemas']['PlayerCareer']
type PlayerStreak = components['schemas']['PlayerStreak']

/** What the card prints where a number would go when the player has none: they
 * have decided nothing, so there is no share and no streak to report. Never a
 * "0%", which would claim they lose every match they play. */
export const NO_VALUE = '—'

/** The win-rate ring. */
export type CareerRingView = {
  /** The win share in `[0, 1]` that draws the arc — `null` when the player has
   * decided nothing, and the ring is drawn empty. Distinct from `0`, which is a
   * *real* rate: a player who has lost every decided match wins 0% of them. */
  share: number | null
  /** The figure in the middle of the ring: "68.6%", or `—` when nothing has been
   * decided. */
  label: string
  /** The whole ring's accessible name, since its inner text is decorative. */
  ariaLabel: string
}

/** The current-streak pill. `null` when there is no streak to be on. */
export type CareerStreakView = {
  /** e.g. "On a 2-win streak" / "On a 3-loss streak". */
  label: string
  tone: 'win' | 'loss'
}

/** One of the two small tiles under the record: Best streak, Games won. */
export type CareerTileView = {
  label: string
  /** `—` when the player has no such number yet — never a zero. */
  value: string
}

export type CareerView = {
  ring: CareerRingView
  /** The lifetime record, e.g. "24 W · 11 L". Read off `career`, never off the
   * bundle's top-level `wins`/`losses`, which are league-scoped. */
  record: string
  streak: CareerStreakView | null
  /** Best streak, then Games won — both always present; a missing value reads
   * `—`. */
  tiles: CareerTileView[]
  /**
   * The card's total, e.g. "35 decided · 2 leagues".
   *
   * The count is `career.decided` — matches with a *result*. It is deliberately
   * **not** the "View all N matches" number on the Recent-matches card beside
   * it (`match_total`), which counts the all-inclusive history, matches still in
   * play included. Hence the word "decided": the two numbers differ on purpose
   * and the label is what stops a reader reconciling them (ADR-0915).
   */
  total: string
}

/**
 * A share in `[0, 1]` → the percentage a human reads.
 *
 * The wire's `win_rate` and `games_won_pct` are **shares**, despite the `_pct`
 * name — `0.375` means *37.5%*. Printing the raw number would say "0.375%" and
 * rounding it as an integer would say "0%"; both are catastrophically wrong.
 *
 * `null` (the player has decided nothing) is an em dash — **not** `0%`. A `0`
 * that the API actually sent *is* rendered "0%": that player has decided
 * matches and lost every one of them, which is a true statement about them.
 */
export const formatShare = (share: number | null | undefined): string => {
  if (share == null) return NO_VALUE
  const clamped = Math.min(1, Math.max(0, share))
  // One decimal, and no trailing ".0" — 0.375 → "37.5%", 0.5 → "50%".
  return `${Math.round(clamped * 1000) / 10}%`
}

const selectRing = (career: PlayerCareer): CareerRingView => {
  const label = formatShare(career.win_rate)
  return {
    share: career.win_rate ?? null,
    label,
    ariaLabel:
      career.win_rate == null
        ? 'Win rate unavailable: no decided matches yet'
        : `Win rate ${label}`,
  }
}

const selectStreak = (
  streak: PlayerStreak | null | undefined,
): CareerStreakView | null => {
  // `null`, never `n: 0` — the absence of a streak is the field being absent
  // (CONTEXT.md § Streak).
  if (streak == null) return null
  return {
    // "2-win" / "3-loss" is a compound adjective, so it never pluralizes.
    label: `On a ${streak.n}-${streak.kind === 'W' ? 'win' : 'loss'} streak`,
    tone: streak.kind === 'W' ? 'win' : 'loss',
  }
}

/** The best streak is a *count of matches*, so it does pluralize — and it is
 * `null` for a player who has never won, who has no winning run to their name. */
const selectBestStreak = (
  streak: PlayerStreak | null | undefined,
): CareerTileView => {
  if (streak == null) return { label: 'Best streak', value: NO_VALUE }
  const noun = streak.kind === 'W' ? 'win' : 'loss'
  const plural = streak.kind === 'W' ? 'wins' : 'losses'
  return {
    label: 'Best streak',
    value: `${streak.n} ${streak.n === 1 ? noun : plural}`,
  }
}

const selectTotal = (career: PlayerCareer): string => {
  const leagues = career.league_count
  return `${career.decided} decided · ${leagues} ${
    leagues === 1 ? 'league' : 'leagues'
  }`
}

/**
 * The **cross-league** career (ADR-0915) — a fact about the *person*, not about
 * a ladder.
 *
 * Everything here comes off `player.career`, and nothing off the bundle's
 * top-level `wins`/`losses`/`rating`, which are league-scoped and would make
 * this card change when the league switcher does. It must not.
 */
export const selectCareer = (player: PlayerDetail): CareerView => {
  const career = player.career
  return {
    ring: selectRing(career),
    record: `${career.wins} W · ${career.losses} L`,
    streak: selectStreak(career.current_streak),
    tiles: [
      selectBestStreak(career.best_streak),
      { label: 'Games won', value: formatShare(career.games_won_pct) },
    ],
    total: selectTotal(career),
  }
}

/**
 * The Career card, projected off the profile bundle.
 *
 * Spreads `playerByIdQueryOptions` and adds a `select` — same key, same fetch, a
 * different view model — so the card costs **no second request**: it reads the
 * career block the bundle already carries, off the very cache entry the hero and
 * the Recent-matches card read.
 *
 * Note what it does *not* take: a league. Career ignores the profile's league
 * (ADR-0915), so the league switcher must not change a number on this card, and
 * a league in this key would be the first step towards it doing so.
 */
export const careerCardQuery = (playerId: string) => ({
  ...playerByIdQueryOptions(playerId),
  select: selectCareer,
})
