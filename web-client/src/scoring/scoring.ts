// The rules of a table tennis game and match, as fortymm-real enforces them
// (its web-client/src/lib/scoring.ts and api/app/match_scoring.py), with its
// messages, so people see the same words. Pure: no React, no storage, no
// side effects. The shared core's rules replace these later.
//
// A score is a pair [a, b] in the order of the match's two sides. A match's
// saved games are a list in game order: games[0] is game 1. Saving through
// `saveRefusal` keeps that list contiguous and every game in it legal, and the
// match functions take it to be so.

// Every length a match can be, shortest first: the most games it can take.
// The new match form's schema and its BestOfField take them from here.
export const bestOfs = [1, 3, 5, 7] as const
export type BestOf = (typeof bestOfs)[number]

export type Score = readonly [number, number]

// The games a side must win to take the match: more than half of best of.
export function gamesToWin(bestOf: BestOf): number {
  return Math.ceil(bestOf / 2)
}

// Why a game's final score is illegal, or null when it is legal. A game is to
// 11 and has no tie; once both sides reach 10 the winner leads by exactly 2;
// each side is a whole number from 0 to 99.
export function illegalGameReason([a, b]: Score): string | null {
  if (![a, b].every((points) => Number.isInteger(points) && points >= 0))
    return 'Enter each score as a whole number from 0 to 99.'
  const winner = Math.max(a, b)
  const loser = Math.min(a, b)
  if (winner > 99) return 'Each side can score at most 99 points.'
  if (winner < 11) return 'The winning side must reach at least 11 points.'
  if (a === b) return 'A game cannot end in a tie.'
  if (winner === 11 && loser > 9)
    return 'At 10–10 the game enters deuce — the winner must lead by 2.'
  if (winner > 11) {
    if (loser < 10) return 'A game can only go past 11 once both sides reach 10.'
    if (winner - loser !== 2)
      return 'In a deuce game the winner leads by exactly 2 points.'
  }
  return null
}

// The games each side has won, in the order of the sides.
export function gamesWon(games: readonly Score[]): [number, number] {
  const won: [number, number] = [0, 0]
  for (const [a, b] of games) won[a > b ? 0 : 1] += 1
  return won
}

// The number of the game that decided the match: the first game after which
// a side has won `gamesToWin` games. Null while the games saved decide nothing.
export function decidingGame(games: readonly Score[], bestOf: BestOf): number | null {
  const target = gamesToWin(bestOf)
  const won: [number, number] = [0, 0]
  for (const [index, [a, b]] of games.entries()) {
    const side = a > b ? 0 : 1
    won[side] += 1
    if (won[side] === target) return index + 1
  }
  return null
}

// Whether the games saved decide the match. The match is over when its
// deciding game is saved.
export function isDecided(games: readonly Score[], bestOf: BestOf): boolean {
  return decidingGame(games, bestOf) !== null
}

// The number of the next game to score, or null once the match is decided.
export function nextGame(games: readonly Score[], bestOf: BestOf): number | null {
  return isDecided(games, bestOf) ? null : games.length + 1
}

export type SaveRefusal = {
  reason: 'past-best-of' | 'non-contiguous' | 'past-decider' | 'illegal'
  message: string
}

// Why saving `score` as game `game` would be refused, or null when it may be
// saved. A new game is saved only right after the games saved (game N after
// 1..N-1), and never once the match is decided. A saved game may be corrected
// at any time, unless the correction would decide the match before a later
// saved game: that game would then be past the decider, so the edit is refused
// (as fortymm-real's is) rather than dropping any game silently.
export function saveRefusal(
  games: readonly Score[],
  bestOf: BestOf,
  game: number,
  score: Score,
): SaveRefusal | null {
  if (!Number.isInteger(game) || game < 1 || game > bestOf)
    return {
      reason: 'past-best-of',
      message: `This match is best of ${bestOf}; game ${game} can't exist.`,
    }
  const firstUnsaved = games.length + 1
  if (game > firstUnsaved)
    return {
      reason: 'non-contiguous',
      message: `Save game ${firstUnsaved} before game ${game}.`,
    }
  const decidedAt = decidingGame(games, bestOf)
  if (game === firstUnsaved && decidedAt !== null)
    return {
      reason: 'past-decider',
      message: `The match was already decided at game ${decidedAt}; game ${game} can't be played.`,
    }
  const illegal = illegalGameReason(score)
  if (illegal !== null) return { reason: 'illegal', message: illegal }
  if (game === firstUnsaved) return null
  const decidedAfter = decidingGame(games.with(game - 1, score), bestOf)
  if (decidedAfter !== null && decidedAfter < games.length)
    return {
      reason: 'past-decider',
      message: `The match is already decided at game ${decidedAfter} — clear the games after it before saving this score.`,
    }
  return null
}

// Whether game `game` may be cleared: only the highest saved game may, so
// the games saved stay contiguous.
export function mayClear(games: readonly Score[], game: number): boolean {
  return games.length > 0 && game === games.length
}
