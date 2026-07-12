import {
  mockMatches,
  newMatchSeed,
  projectMatchDetails,
  projectRating,
  type SeedGame,
  type SeedMatch,
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

/** The seed store's rated, completed matches, oldest first — the same walk
 * `projectRating` does. The first of them is the current user's FIRST rated
 * match: the one that brought their rating into existence. */
function ratedCompletedSeeds(): SeedMatch[] {
  return mockMatches
    .filter(
      (m): m is SeedMatch & { completed_at: string } =>
        m.status === 'completed' &&
        m.completed_at !== null &&
        m.opponent !== null &&
        m.affects_rating,
    )
    .sort((a, b) => a.completed_at.localeCompare(b.completed_at))
}

describe('projectRating (the dashboard rating card the mock feeds)', () => {
  // #952. This mock used to flatten the establishing match's null delta to `0`
  // (`lastDelta = change.delta ?? 0`), so MSW could not *express* a rating that
  // had been established rather than moved — and the card's `delta >= 0` phantom
  // (`null >= 0` is `false` ⇒ a loss-toned chip announcing a 232-point fall from
  // a 1500 the player never held) survived every round of testing. If this test
  // is ever "simplified" back to a number, the bug becomes untestable again.
  it('emits a NULL delta when the only rated match ESTABLISHED the rating', () => {
    const [first] = ratedCompletedSeeds()

    const rating = projectRating([first])

    expect(rating).not.toBeNull()
    expect(rating?.delta).toBeNull()
    // The spark carries the rated result only — never the seed row — so a
    // one-match player has exactly one point, and peaks at the rating they hold.
    expect(rating?.spark_data).toHaveLength(1)
    expect(rating?.peak).toBe(rating?.current)
    expect(rating?.current).not.toBe(1500)
  })

  it('emits a signed number once a later match has MOVED the rating', () => {
    const seeds = ratedCompletedSeeds()
    expect(seeds.length).toBeGreaterThan(1)

    const rating = projectRating(seeds)

    expect(typeof rating?.delta).toBe('number')
    expect(rating?.delta).not.toBe(0)
  })
})
