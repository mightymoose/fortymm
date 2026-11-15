import type { ListedMatch } from './MatchListScreen.tsx'

// SAMPLE DATA, to delete when the match store is connected. Until then the
// matches list (/matches) shows these three, and the match details page
// keeps its own copy of the same three (same ids and values) so the two
// screens are built apart. Nothing here is stored or fetched.
//
// Each game's points are you first, then the opponent. `startedAt` is this
// list's own addition, for its newest-first order; the brief's values say
// nothing of when a match started.
type SampleMatch = {
  id: string
  opponent: string
  bestOf: 1 | 3 | 5 | 7
  rated: boolean
  startedAt: Date
  games: readonly (readonly [you: number, them: number])[]
}

export const sampleMatches: readonly SampleMatch[] = [
  {
    // In progress: 2 games to 1, game 4 next.
    id: 'sample-1',
    opponent: 'Ana',
    bestOf: 5,
    rated: false,
    startedAt: new Date('2026-11-14T17:00:00Z'),
    games: [
      [11, 7],
      [9, 11],
      [11, 5],
    ],
  },
  {
    // Finished: you won 2-0.
    id: 'sample-2',
    opponent: 'Ben',
    bestOf: 3,
    rated: true,
    startedAt: new Date('2026-11-13T19:30:00Z'),
    games: [
      [11, 9],
      [11, 8],
    ],
  },
  {
    // No games yet.
    id: 'sample-3',
    opponent: 'Chen',
    bestOf: 5,
    rated: false,
    startedAt: new Date('2026-11-14T18:00:00Z'),
    games: [],
  },
]

// The samples as the list shows them: the games each side has won, and
// whether either has won the match (more than half of `bestOf`). Throwaway
// with the samples: the store, through the core, will say this.
export function listedSampleMatches(): ListedMatch[] {
  return sampleMatches.map(({ games, ...match }) => {
    const you = games.filter(([a, b]) => a > b).length
    const them = games.length - you
    const toWin = Math.floor(match.bestOf / 2) + 1
    return {
      ...match,
      games: { you, them },
      finished: you >= toWin || them >= toWin,
    }
  })
}
