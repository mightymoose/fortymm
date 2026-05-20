// Mirrors the server-side table-tennis rule in api/app/schemas/match.py
// (MatchGameScoreWrite._table_tennis_rules) so the client doesn't submit a
// final score the server will reject with a 422. Returns the reason a score is
// illegal, or null when it's a legal final score.
export function illegalScoreReason(a: number, b: number): string | null {
  if (a === b) return 'A game cannot end in a tie.'
  const winner = Math.max(a, b)
  const loser = Math.min(a, b)
  if (winner < 11) return 'The winning side must reach at least 11 points.'
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
