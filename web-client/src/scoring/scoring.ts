// The rules of a table tennis game and match, as fortymm-real enforces them
// (its web-client/src/lib/scoring.ts and api/app/match_scoring.py), with its
// messages, so people see the same words. Pure: no React, no storage, no
// side effects. The shared core's rules replace these later.
//
// A score is a pair [a, b] in the order of the match's two sides. A match's
// games are slots, one per game number from 1 to best of: games[0] is game 1,
// and a slot holds that game's score or null. A slot past the end of the list
// is empty too, so a match with nothing saved is [] and one with only game 3
// saved is [null, null, score]; `withGame` keeps the list without empty slots
// at its end. Games may be saved in any order, so a match can have gaps.
// Saving through `saveRefusal` keeps every saved game legal, and the match
// functions take it to be so.

// Every length a match can be, shortest first: the most games it can take.
// The new match form's schema and its BestOfField take them from here.
export const bestOfs = [1, 3, 5, 7] as const
export type BestOf = (typeof bestOfs)[number]

export type Score = readonly [number, number]

// A match's games, one slot per game number: a score, or null (or nothing,
// past the end of the list) for a game not saved.
export type Games = readonly (Score | null)[]

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

// Game `game`'s saved score (1 is the first), or null when it isn't saved.
export function savedScore(games: Games, game: number): Score | null {
  return games[game - 1] ?? null
}

// The games with game `game` set to `score`, or emptied by null; the list
// ends at its last saved game.
export function withGame(games: Games, game: number, score: Score | null): Games {
  const slots = Array.from(
    { length: Math.max(games.length, game) },
    (_, index) => (index === game - 1 ? score : (games[index] ?? null)),
  )
  while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop()
  return slots
}

// The games each side has won, in the order of the sides, wherever they sit.
export function gamesWon(games: Games): [number, number] {
  const won: [number, number] = [0, 0]
  for (const score of games) if (score !== null) won[score[0] > score[1] ? 0 : 1] += 1
  return won
}

// The game that decided the match: the first, in game order, by which one
// side has won `gamesToWin` of the saved games; null while undecided. A game
// before it was played, saved or not (an empty one is a game cleared by
// mistake, or not entered yet); a game after it can't be.
export function decidingGame(games: Games, bestOf: BestOf): number | null {
  const won: [number, number] = [0, 0]
  for (const [index, score] of games.entries()) {
    if (score === null) continue
    won[score[0] > score[1] ? 0 : 1] += 1
    if (Math.max(...won) >= gamesToWin(bestOf)) return index + 1
  }
  return null
}

// Whether the match is decided: one side has won `gamesToWin` games, in
// whichever slots they sit.
export function isDecided(games: Games, bestOf: BestOf): boolean {
  return decidingGame(games, bestOf) !== null
}

// Whether game `game` comes after the game that decided the match, so it
// can't be played.
export function pastDecider(games: Games, bestOf: BestOf, game: number): boolean {
  const decider = decidingGame(games, bestOf)
  return decider !== null && game > decider
}

// The number of the next game to score: the lowest empty game while the
// match is undecided; null once it is decided.
export function nextGame(games: Games, bestOf: BestOf): number | null {
  if (isDecided(games, bestOf)) return null
  for (let game = 1; game <= bestOf; game += 1)
    if (savedScore(games, game) === null) return game
  return null
}

export type SaveRefusal = {
  reason: 'past-best-of' | 'past-decider' | 'illegal'
  message: string
}

// Why saving `score` as game `game` would be refused, or null when it may be
// saved. A saved game may be corrected at any time, whatever the correction
// does to the match. An empty game, in any order, is judged by the match its
// save would make: refused when a saved game would then come after the
// deciding game (`decidingGame`), since nothing is played past it. So an
// empty game after the decider is refused whatever its score, and one
// before it (a game cleared by mistake) takes any score that leaves every
// saved game at or before the decider.
export function saveRefusal(
  games: Games,
  bestOf: BestOf,
  game: number,
  score: Score,
): SaveRefusal | null {
  if (!Number.isInteger(game) || game < 1 || game > bestOf)
    return {
      reason: 'past-best-of',
      message: `This match is best of ${bestOf}; game ${game} can't exist.`,
    }
  const empty = savedScore(games, game) === null
  if (empty && pastDecider(games, bestOf, game))
    return {
      reason: 'past-decider',
      message: `The match is already decided; game ${game} can't be played.`,
    }
  const illegal = illegalGameReason(score)
  if (illegal !== null) return { reason: 'illegal', message: illegal }
  if (empty) {
    const after = withGame(games, game, score)
    const decider = decidingGame(after, bestOf)
    // The first saved game after the decider (slot index `decider` is game
    // decider + 1).
    const later = decider === null ? -1 : after.findIndex((saved, index) => index >= decider && saved !== null)
    if (decider !== null && later !== -1)
      return {
        reason: 'past-decider',
        message: `With this score the match is decided in game ${decider}, so game ${later + 1} can't have been played.`,
      }
  }
  return null
}

// Whether game `game` may be cleared: any saved game may.
export function mayClear(games: Games, game: number): boolean {
  return savedScore(games, game) !== null
}
