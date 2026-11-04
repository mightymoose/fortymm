// The rules of a match's score board: whether one game's score is a legal
// final score, and what a board of games says about the match.

// 0 is the match's first player, 1 its second.
export type Side = 0 | 1

// A game's points in the match's `players` order.
export type GamePoints = [number, number]

export type BestOf = 1 | 3 | 5 | 7

export type LegalScore = { kind: 'legal'; points: GamePoints; winner: Side }

export type IllegalScore = { kind: 'illegal'; reason: string }

// What two typed scores make.
export type ScoreEntry =
  | { kind: 'empty' }
  | { kind: 'partial' }
  | { kind: 'malformed' }
  | IllegalScore
  | LegalScore

// The board's games, indexed by game number less 1.
export type Slots = readonly (GamePoints | null)[]

// What a board says about the match.
export type Review =
  // `games` are the filled games in game order, up to and including the
  // decider.
  | { kind: 'decided'; decidedAtGame: number; winner: Side; games: GamePoints[]; tally: [number, number] }
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
  return { kind: 'legal', points, winner: winnerOf(points) }
}

function illegal(reason: string): IllegalScore {
  return { kind: 'illegal', reason }
}

export function otherSide(side: Side): Side {
  return side === 0 ? 1 : 0
}

// The side that won a legal game.
export function winnerOf(points: GamePoints): Side {
  return points[0] > points[1] ? 0 : 1
}

// The games each side has won.
export function tally(slots: Slots): [number, number] {
  const won: [number, number] = [0, 0]
  for (const points of slots) {
    if (points) won[winnerOf(points)] += 1
  }
  return won
}

// The side that won more of `games`, as a submitted result's games say.
export function matchWinner(games: readonly GamePoints[]): Side {
  const won = tally(games)
  return won[0] > won[1] ? 0 : 1
}

// The match the board describes, in one pass over the slots.
export function reviewBoard(slots: Slots, bestOf: BestOf): Review {
  const needed = (bestOf + 1) / 2
  const won: [number, number] = [0, 0]
  const games: GamePoints[] = []
  for (const [index, points] of slots.entries()) {
    if (!points) continue
    const winner = winnerOf(points)
    won[winner] += 1
    games.push(points)
    if (won[winner] < needed) continue
    const decidedAtGame = index + 1
    const extraGames = slots.flatMap((later, at) => (later && at > index ? [at + 1] : []))
    if (extraGames.length > 0) return { kind: 'overrun', decidedAtGame, extraGames }
    return { kind: 'decided', decidedAtGame, winner, games, tally: won }
  }
  return { kind: 'undecided', tally: won, gamesToWin: needed }
}
