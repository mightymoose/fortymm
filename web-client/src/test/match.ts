import type { BestOf, Games } from '../scoring/scoring.ts'
import { matchStore } from '../stores/match.ts'
import { matchesStore } from '../stores/matches.ts'

// For tests of what opens a match: a match in the app's own
// stores (in memory), with these games saved (a null slot left empty), in
// game order. Gives its id.
export async function createMatch(bestOf: BestOf, games: Games = []): Promise<string> {
  const created = await matchesStore.getState().createMatch({
    format: { bestOf },
    rated: false,
  })
  if (!created.ok) throw new Error(`match not created: ${created.reason}`)
  for (const [index, score] of games.entries()) {
    if (score === null) continue
    const saved = await matchStore.getState().setGameScore(created.matchId, index + 1, score)
    if (!saved.ok) throw new Error(`game ${index + 1} not saved: ${saved.reason}`)
  }
  return created.matchId
}
