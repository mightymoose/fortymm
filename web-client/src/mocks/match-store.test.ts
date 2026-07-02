import {
  newMatchSeed,
  projectMatchDetails,
  type SeedGame,
} from '@/mocks/match-store'

/** Builds the scratchpad games array for a seed: one entry per scored game,
 * left as-is (gaps and all) so tests can exercise the store's own compaction. */
function scoredGames(
  scores: { game_number: number; side_1_points: number; side_2_points: number }[],
): SeedGame[] {
  return scores.map((s) => ({
    id: `g-${s.game_number}`,
    game_number: s.game_number,
    score: {
      id: `s-${s.game_number}`,
      side_1_points: s.side_1_points,
      side_2_points: s.side_2_points,
    },
  }))
}

describe('canFinalizeSeed (via projectMatchDetails)', () => {
  it('reports finalizable for a gappy-but-decided board — an out-of-order clinch that left a hole, matching the API compaction (ADR 0002)', () => {
    const seed = newMatchSeed({
      bestOf: 5,
      rated: false,
      opponent: { id: 'u-opp', username: 'rival' },
    })
    // Side 1 clinches at game 5 (3rd win) while game 4 was never scored —
    // saved board is [1,2,3,5].
    seed.games = scoredGames([
      { game_number: 1, side_1_points: 11, side_2_points: 7 },
      { game_number: 2, side_1_points: 11, side_2_points: 8 },
      { game_number: 3, side_1_points: 9, side_2_points: 11 },
      { game_number: 5, side_1_points: 11, side_2_points: 6 },
    ])

    expect(projectMatchDetails(seed).can_finalize).toBe(true)
  })

  it('reports not finalizable for a real overrun — games scored after the decider', () => {
    const seed = newMatchSeed({
      bestOf: 5,
      rated: false,
      opponent: { id: 'u-opp', username: 'rival' },
    })
    // Side 1 clinches at game 3 (3rd win) but game 4 is also scored — an
    // impossible "kept playing after winning" board.
    seed.games = scoredGames([
      { game_number: 1, side_1_points: 11, side_2_points: 7 },
      { game_number: 2, side_1_points: 11, side_2_points: 8 },
      { game_number: 3, side_1_points: 11, side_2_points: 9 },
      { game_number: 4, side_1_points: 11, side_2_points: 6 },
    ])

    expect(projectMatchDetails(seed).can_finalize).toBe(false)
  })
})
