import { checkGame } from '../../../scoring/board'

export type Side = 0 | 1
export type GameScore = readonly [number, number]
export type BestOf = 1 | 3 | 5 | 7

export type MatchPlayer = { name: string; you: boolean }

// One step in the match's history. `games` are the scores it carried, side
// 0's points first, and `side` the side a signature was for.
export type MatchEvent = {
  at: string
  kind: 'created' | 'board' | 'signed' | 'approved' | 'override'
  by: string | null
  side: Side | null
  games: readonly GameScore[]
}

// `new`: nobody has kept score yet.
// `live`: someone is keeping score on the board.
// `awaiting`: one side signed the scores and the other side hasn't yet.
// `disputed`: the sides signed different scores. `theirGames` is what the
// other side signed, `games` what `signedBy` signed.
// `final`: the result counts. `approvedBy` is both sides, one side for an
// unrated result only one side reported, and none when an administrator
// set it, with `overrideReason`.
export type MatchStatus =
  | { kind: 'new' }
  | { kind: 'live' }
  | { kind: 'awaiting'; signedBy: Side; signedAt: string }
  | { kind: 'disputed'; signedBy: Side; signedAt: string; theirGames: readonly GameScore[] }
  | { kind: 'final'; acceptedAt: string; approvedBy: readonly Side[]; overrideReason: string | null }

export type MatchRecord = {
  id: string
  bestOf: BestOf
  rated: boolean
  players: readonly [MatchPlayer, MatchPlayer]
  games: readonly GameScore[]
  retiredBy: Side | null
  startedAt: string
  status: MatchStatus
}

export type MatchDetail = MatchRecord & { history: readonly MatchEvent[] }

export const other = (side: Side): Side => (side === 0 ? 1 : 0)

// Whether the game reached a final score. The last game of a retired match
// may not have.
export const finished = (game: GameScore) => checkGame([game[0], game[1]]).kind === 'legal'

export const wonOf = (games: readonly GameScore[], side: Side) =>
  games.filter((game) => finished(game) && game[side] > game[other(side)]).length

// A board holds the finished games and the one being played, so a live
// match's last game is in play until it reaches a final score.
export function lastGameInPlay(match: MatchRecord): boolean {
  const last = match.games[match.games.length - 1]
  return match.status.kind === 'live' && last !== undefined && !finished(last)
}

// The games each side has won, the game in play, and the winner once the
// match is final: the side that didn't retire, or else the side with more
// games.
export function score(match: MatchRecord) {
  const inPlay = lastGameInPlay(match)
  const done = inPlay ? match.games.slice(0, -1) : match.games
  const current = inPlay ? match.games[match.games.length - 1] : null
  const won = [wonOf(done, 0), wonOf(done, 1)] as const
  let winner: Side | null = null
  if (match.status.kind === 'final') {
    winner = match.retiredBy !== null ? other(match.retiredBy) : won[0] > won[1] ? 0 : 1
  }
  return { done, current, won, winner }
}

export function yourSide(match: MatchRecord): Side | null {
  if (match.players[0].you) return 0
  if (match.players[1].you) return 1
  return null
}

export const vsLabel = (match: MatchRecord) => `${match.players[0].name} vs ${match.players[1].name}`

export const formatLabel = (match: MatchRecord) =>
  `Best of ${match.bestOf} · ${match.rated ? 'Rated' : 'Unrated'}`

const dayFormat = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short' })
const timeFormat = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false })

export const formatDay = (iso: string) => dayFormat.format(new Date(iso))
export const formatTime = (iso: string) => timeFormat.format(new Date(iso))

const tally = (games: readonly GameScore[]) => `${wonOf(games, 0)}–${wonOf(games, 1)}`

const sameGames = (a: readonly GameScore[], b: readonly GameScore[]) =>
  a.length === b.length && a.every((game, index) => game[0] === b[index][0] && game[1] === b[index][1])

// What one history event says its actor did, after their name. A signature
// of other scores than the ones last signed, approved or set signed
// different scores.
export function eventText(history: readonly MatchEvent[], index: number): string {
  const event = history[index]
  switch (event.kind) {
    case 'created':
      return 'Started the match'
    case 'board': {
      const last = event.games[event.games.length - 1]
      if (!last) return 'Started keeping score'
      return `Saved game ${event.games.length}, ${last[0]}–${last[1]}`
    }
    case 'signed': {
      const before = history.slice(0, index).findLast((e) => e.kind !== 'created' && e.kind !== 'board')
      const counters = before !== undefined && !sameGames(before.games, event.games)
      return `${counters ? 'Signed different scores' : 'Signed the result'}, ${tally(event.games)}`
    }
    case 'approved':
      return 'Approved the result'
    case 'override':
      return `Set the result, ${tally(event.games)}`
  }
}
