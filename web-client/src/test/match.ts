import type { BestOf, Score } from '../scoring/scoring.ts'
import { matchStore } from '../stores/match.ts'
import { myMatchesStore } from '../stores/my-matches.ts'

// For tests of what opens a match: a match against Ana in the app's own
// stores (in memory), with these games saved. Gives its id.
export async function createMatch(bestOf: BestOf, games: Score[] = []): Promise<string> {
  const created = await myMatchesStore.getState().createMatch({
    opponentName: 'Ana',
    format: { bestOf, points: 11 },
    rated: false,
  })
  if (!created.ok) throw new Error(`match not created: ${created.reason}`)
  for (const [index, score] of games.entries()) {
    const saved = await matchStore.getState().setGameScore(created.matchId, index + 1, score)
    if (!saved.ok) throw new Error(`game ${index + 1} not saved: ${saved.reason}`)
  }
  return created.matchId
}
