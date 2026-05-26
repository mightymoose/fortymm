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

export type GamePoints = {
  game_number: number
  side_1_points: number
  side_2_points: number
}

// Mirrors the server-side finalize-payload cross-game validator in
// api/app/matches.py (_validate_finalize_games). Returns the decided side
// number (1 or 2) when the given games form a complete, validly-ordered,
// decided match for the given best_of — and null otherwise. Used by the
// scoring page to decide whether the submit button should save-this-game or
// finalize-the-match.
export function decidedSide(
  games: GamePoints[],
  bestOf: number,
): 1 | 2 | null {
  if (games.length === 0) return null

  const numbers = games.map((g) => g.game_number).sort((a, b) => a - b)
  // No duplicates / gaps / numbers past best_of.
  if (numbers[numbers.length - 1] > bestOf) return null
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) return null
  }

  const target = Math.ceil(bestOf / 2)
  const ordered = [...games].sort((a, b) => a.game_number - b.game_number)
  const wins: Record<1 | 2, number> = { 1: 0, 2: 0 }
  let decidedAt: number | null = null
  let decidedBy: 1 | 2 | null = null
  for (const g of ordered) {
    if (illegalScoreReason(g.side_1_points, g.side_2_points)) return null
    const winner: 1 | 2 = g.side_1_points > g.side_2_points ? 1 : 2
    wins[winner] += 1
    if (decidedBy === null && wins[winner] >= target) {
      decidedBy = winner
      decidedAt = g.game_number
    }
  }
  if (decidedBy === null) return null
  // No scored games past the decider.
  if (decidedAt !== ordered[ordered.length - 1].game_number) return null
  return decidedBy
}
