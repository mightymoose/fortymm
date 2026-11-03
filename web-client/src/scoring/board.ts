// The rules of a match's score board: whether one game's score is a legal
// final score, and what a board of games says about the match.

// 0 is the match's first player, 1 its second.
export type Side = 0 | 1

// A game's points in the match's `players` order, the order of
// `MatchResult.games`.
export type GamePoints = [number, number]

export type BestOf = 3 | 5 | 7

export type LegalScore = { kind: 'legal'; points: GamePoints; winner: Side }

export type IllegalScore = { kind: 'illegal'; reason: string }

// What two typed scores make.
export type ScoreEntry =
  | { kind: 'empty' }
  | { kind: 'partial' }
  | { kind: 'malformed' }
  | IllegalScore
  | LegalScore

// What a board says about the match when a player reviews it.
export type Review =
  // `games` are the filled games in game order, up to and including the
  // decider. `closedGaps` says that empty games before the decider were left
  // out, so later games moved up.
  | { kind: 'decided'; winner: Side; games: GamePoints[]; tally: [number, number]; closedGaps: boolean }
  | { kind: 'undecided'; tally: [number, number]; gamesToWin: number }
  // Games were filled in after the game that decided the match.
  | { kind: 'overrun'; decidedAtGame: number; extraGames: number[] }

const SCORE = /^\d{1,2}$/

export function parseGameScore(a: string, b: string): ScoreEntry {
  const typed = [a.trim(), b.trim()]
  if (typed.every((text) => text === '')) return { kind: 'empty' }
  if (typed.some((text) => text !== '' && !SCORE.test(text))) return { kind: 'malformed' }
  if (typed.some((text) => text === '')) return { kind: 'partial' }
  return checkGame([Number(typed[0]), Number(typed[1])])
}

// Whether `points` is a legal final score of one game: the winner has at
// least 11, with at most 9 for the loser at 11, or else exactly 2 ahead of a
// loser who reached 10.
export function checkGame(points: GamePoints): LegalScore | IllegalScore {
  const [a, b] = points
  const score = `${a}–${b}`
  if (a === b) return illegal(`A game can’t end level. ${score} can’t be a final score.`)
  const winner: Side = a > b ? 0 : 1
  const high = Math.max(a, b)
  const low = Math.min(a, b)
  if (high < 11) return illegal(`A game ends when a player reaches 11. ${score} can’t be a final score.`)
  if (high === 11 && low === 10) {
    return illegal(
      `At 10–10 the game goes to deuce, so the winner needs a 2-point lead. ${score} can’t be a final score.`,
    )
  }
  if (high > 11 && low < 10) {
    return illegal(`The game ends as soon as a player reaches 11 with a 2-point lead. ${score} can’t be a final score.`)
  }
  if (high > 11 && high - low !== 2) {
    return illegal(`After deuce the game ends at a 2-point lead. ${score} can’t be a final score.`)
  }
  return { kind: 'legal', points, winner }
}

function illegal(reason: string): IllegalScore {
  return { kind: 'illegal', reason }
}

export function gamesToWin(bestOf: BestOf): number {
  return (bestOf + 1) / 2
}

// The games each side has won on the board.
export function tally(slots: readonly (GamePoints | null)[]): [number, number] {
  const won: [number, number] = [0, 0]
  for (const points of slots) {
    if (points) won[winnerOf(points)] += 1
  }
  return won
}

// The number of the game that gave a side its winning game, or null while
// nobody has won the match.
export function deciderGame(slots: readonly (GamePoints | null)[], bestOf: BestOf): number | null {
  const needed = gamesToWin(bestOf)
  const won: [number, number] = [0, 0]
  for (const [index, points] of slots.entries()) {
    if (!points) continue
    won[winnerOf(points)] += 1
    if (won[winnerOf(points)] === needed) return index + 1
  }
  return null
}

// The match the board describes. `slots` are indexed by game number less 1.
export function reviewBoard(slots: readonly (GamePoints | null)[], bestOf: BestOf): Review {
  const decider = deciderGame(slots, bestOf)
  if (decider === null) return { kind: 'undecided', tally: tally(slots), gamesToWin: gamesToWin(bestOf) }
  const extraGames = numbersOfFilled(slots).filter((game) => game > decider)
  if (extraGames.length > 0) return { kind: 'overrun', decidedAtGame: decider, extraGames }
  const played = slots.slice(0, decider)
  const games = played.filter((points) => points !== null)
  const won = tally(games)
  return {
    kind: 'decided',
    winner: won[0] > won[1] ? 0 : 1,
    games,
    tally: won,
    closedGaps: games.length < decider,
  }
}

function numbersOfFilled(slots: readonly (GamePoints | null)[]): number[] {
  return slots.flatMap((points, index) => (points ? [index + 1] : []))
}

// The side that won a legal game.
export function winnerOf(points: GamePoints): Side {
  return points[0] > points[1] ? 0 : 1
}
