import { z } from 'zod'

// Mirrors the server-side table-tennis rule in api/app/schemas/match.py
// (MatchGameScoreWrite._table_tennis_rules) so the client doesn't submit a
// final score the server will reject with a 422. Returns the reason a score is
// illegal, or null when it's a legal final score.
export function illegalScoreReason(a: number, b: number): string | null {
  const winner = Math.max(a, b)
  const loser = Math.min(a, b)
  if (winner < 11) return 'The winning side must reach at least 11 points.'
  if (a === b) return 'A game cannot end in a tie.'
  if (winner === 11 && loser > 9)
    return 'At 10–10 the game enters deuce — the winner must lead by 2.'
  if (winner > 11) {
    if (loser < 10)
      return 'A game can only go past 11 once both sides reach 10.'
    if (winner - loser !== 2)
      return 'In a deuce game the winner leads by exactly 2 points.'
  }
  return null
}

// A single legal, completed game score. The `illegalScoreReason` refinement is
// the same per-game table-tennis rule `validateGameScore` applies live to the
// raw inputs — shared here so the composed match schema (below) is built from
// already-legal games. Its message is unreachable in practice (every caller
// pre-gates per-game legality before parsing the match), so a static message
// is fine.
const gameScoreSchema = z
  .object({
    game_number: z.number(),
    side_1_points: z.number(),
    side_2_points: z.number(),
  })
  .refine(
    (g) => illegalScoreReason(g.side_1_points, g.side_2_points) === null,
    { message: 'Each game must be a legal, completed score.' },
  )

export type GamePoints = z.infer<typeof gameScoreSchema>

interface MatchDecision {
  ordered: GamePoints[]
  decidedBy: 1 | 2 | null
  decidedAt: number | null
}

// Walk the games in order and find who (if anyone) first reached `target` game
// wins, and on which game. Pure helper shared by the match-schema refinements.
function matchDecision(games: GamePoints[], target: number): MatchDecision {
  const ordered = [...games].sort((a, b) => a.game_number - b.game_number)
  const wins: Record<1 | 2, number> = { 1: 0, 2: 0 }
  let decidedBy: 1 | 2 | null = null
  let decidedAt: number | null = null
  for (const g of ordered) {
    const winner: 1 | 2 = g.side_1_points > g.side_2_points ? 1 : 2
    wins[winner] += 1
    if (decidedBy === null && wins[winner] >= target) {
      decidedBy = winner
      decidedAt = g.game_number
    }
  }
  return { ordered, decidedBy, decidedAt }
}

/**
 * The schema for a complete, decided match board — a `z.array` of legal games
 * composed with the cross-game completeness rules in
 * api/app/matches.py (`_validate_finalize_games`): numbered 1..N with no
 * gaps/dupes, no game past `best_of`, some side reaches `ceil(best_of/2)` wins,
 * and the decider is the last game (nothing scored past it).
 *
 * One schema, two uses: as a *predicate* (`isDecidedMatch`) the score-entry
 * page and save banner ask "would saving this game finish the match?" to route
 * finalize-vs-save; as straight *validation* (`firstMatchScoreError`) the
 * correction surface surfaces the first failing message inline (#734). Factory
 * because the rules depend on `bestOf`.
 */
function matchScoreSchema(bestOf: number) {
  const target = Math.ceil(bestOf / 2)
  return z
    .array(gameScoreSchema)
    .refine((games) => games.length > 0, {
      message: 'Enter at least one game to finish the match.',
    })
    .refine((games) => games.every((g) => g.game_number <= bestOf), {
      message: `A best-of-${bestOf} match has at most ${bestOf} games.`,
    })
    .refine(
      (games) => {
        const numbers = games.map((g) => g.game_number).sort((a, b) => a - b)
        return numbers.every((n, i) => n === i + 1)
      },
      { message: 'Games must be numbered 1…N with no gaps or duplicates.' },
    )
    .refine((games) => matchDecision(games, target).decidedBy !== null, {
      message: `No side has won ${target} games yet — adjust the scores so the match has a winner.`,
    })
    .refine(
      (games) => {
        const d = matchDecision(games, target)
        return (
          d.decidedBy === null ||
          d.decidedAt === d.ordered[d.ordered.length - 1]?.game_number
        )
      },
      {
        message: `One side reaches ${target} game wins before the last game — adjust the scores so the deciding game is the last one.`,
      },
    )
}

// Whether the given games form a complete, validly-ordered, decided match for
// `best_of` — the boolean predicate over `matchScoreSchema`. Replaces the old
// `decidedSide` (no client consumer needed the winning side number, only
// decided-or-not). Returns false for an empty, non-contiguous, illegal, or
// undecided board — matching every null branch of the prior implementation.
export function isDecidedMatch(games: GamePoints[], bestOf: number): boolean {
  return matchScoreSchema(bestOf).safeParse(games).success
}

// The game number at which the match is first decided, walking scored games in
// game-number order — gap-tolerant, so it answers "past which game can no more
// games be played?" even for a board that still has gaps or trailing scratch
// games. Null when no side has clinched yet. Mirrors the backend `_first_decider`
// in api/app/matches.py.
//
// Distinct from `isDecidedMatch`, which additionally requires a complete,
// contiguous, decider-at-the-last-game board (it drives the Finalize button).
// This one drives score-entry cell gating.
export function deciderGameNumber(
  games: GamePoints[],
  bestOf: number,
): number | null {
  return matchDecision(games, Math.ceil(bestOf / 2)).decidedAt
}

// The game number a board was decided at when later games are *also* scored
// ("overrun") — i.e. a side clinched strictly before the highest-numbered
// scored game, which is impossible (you can't play on after the match is won).
// Null for empty, undecided, or exactly-decided-at-the-last-game boards. The
// FE mirror of the backend `_overrun_decider`; drives the score-entry inline
// block that stops the user saving such a score.
export function overrunDecider(
  games: GamePoints[],
  bestOf: number,
): number | null {
  if (games.length === 0) return null
  const decidedAt = deciderGameNumber(games, bestOf)
  if (decidedAt === null) return null
  const lastScored = Math.max(...games.map((g) => g.game_number))
  return decidedAt < lastScored ? decidedAt : null
}

// The first cross-game completeness rule the board violates, as a human-readable
// message — or null when the board forms a complete, decided match. The
// validation half of `matchScoreSchema` (mirror of the boolean `isDecidedMatch`),
// shown inline by the correction surface (#734). Callers pre-gate per-game
// legality, so the surfaced message is always a board-level one.
export function firstMatchScoreError(
  games: GamePoints[],
  bestOf: number,
): string | null {
  const result = matchScoreSchema(bestOf).safeParse(games)
  return result.success ? null : (result.error.issues[0]?.message ?? null)
}
