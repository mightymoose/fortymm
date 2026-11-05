// Demo players and matches for the prototype player pages. No player-facing
// players API exists yet, so every option draws from this.

export type GameScore = readonly [number, number]

export type Player = { id: string; name: string; club: string; rating: number }

// A singles match, stored once. `games` and `change` list the first
// player's side first.
type FixtureMatch = {
  id: string
  date: string
  event: string
  players: readonly [string, string]
  games: readonly GameScore[]
  change: readonly [number, number]
}

// One match from one player's side: their points first.
export type Result = {
  id: string
  date: string
  event: string
  opponent: Player
  games: readonly GameScore[]
  won: boolean
  change: number
  ratingAfter: number
}

export const VIEWER_ID = 'patel-meera'

export const players: readonly Player[] = [
  { id: 'nguyen-thanh', name: 'Nguyen, Thanh', club: 'Riverside TT', rating: 2145 },
  { id: 'wojcik-agnieszka', name: 'Wójcik-Szymańska, Agnieszka', club: 'Northside', rating: 2088 },
  { id: 'johansen-annika', name: 'Johansen-Whitfield, Annika', club: 'Northside', rating: 2061 },
  { id: 'okafor-daniel', name: 'Okafor-Adeyemi, Daniel', club: 'Eastgate', rating: 1987 },
  { id: 'moreau-elodie', name: 'Moreau, Élodie', club: 'Eastgate', rating: 1930 },
  { id: 'chen-wei', name: 'Chen, Wei', club: 'Riverside TT', rating: 1901 },
  { id: 'patel-meera', name: 'Patel, Meera', club: 'Riverside TT', rating: 1840 },
  { id: 'park-jiho', name: 'Park, Ji-ho', club: 'Eastgate', rating: 1812 },
  { id: 'fernandez-marisol', name: 'Fernández-Castillo, Marisol', club: 'Northside', rating: 1765 },
  { id: 'ali-rashid', name: 'Ali, Rashid', club: 'Eastgate', rating: 1745 },
  { id: 'nguyen-linh', name: 'Nguyen, Linh', club: 'Eastgate', rating: 1702 },
  { id: 'lindqvist-erik', name: 'Lindqvist, Erik', club: 'Northside', rating: 1688 },
]

// Newest first.
const matches: readonly FixtureMatch[] = [
  { id: 'm20', date: '2026-11-03', event: 'Club night', players: ['patel-meera', 'park-jiho'], games: [[11, 8], [6, 11], [11, 9], [11, 7]], change: [12, -12] },
  { id: 'm19', date: '2026-11-03', event: 'Club night', players: ['chen-wei', 'patel-meera'], games: [[11, 9], [9, 11], [11, 13], [11, 6], [11, 8]], change: [9, -9] },
  { id: 'm18', date: '2026-11-02', event: 'Spring Open', players: ['nguyen-thanh', 'okafor-daniel'], games: [[11, 5], [11, 7], [11, 9]], change: [4, -4] },
  { id: 'm17', date: '2026-11-02', event: 'Spring Open', players: ['wojcik-agnieszka', 'johansen-annika'], games: [[11, 9], [8, 11], [12, 10], [11, 9]], change: [8, -8] },
  { id: 'm16', date: '2026-10-29', event: 'Club night', players: ['patel-meera', 'fernandez-marisol'], games: [[11, 4], [11, 8], [11, 6]], change: [7, -7] },
  { id: 'm15', date: '2026-10-29', event: 'Club night', players: ['moreau-elodie', 'ali-rashid'], games: [[11, 7], [11, 9], [9, 11], [11, 5]], change: [6, -6] },
  { id: 'm14', date: '2026-10-27', event: 'League · Division 2', players: ['park-jiho', 'patel-meera'], games: [[11, 9], [11, 7], [7, 11], [11, 9]], change: [13, -13] },
  { id: 'm13', date: '2026-10-27', event: 'League · Division 2', players: ['lindqvist-erik', 'nguyen-linh'], games: [[11, 8], [9, 11], [11, 9], [6, 11], [11, 9]], change: [5, -5] },
  { id: 'm12', date: '2026-10-22', event: 'Club night', players: ['patel-meera', 'nguyen-linh'], games: [[11, 6], [11, 9], [11, 8]], change: [5, -5] },
  { id: 'm11', date: '2026-10-22', event: 'Club night', players: ['okafor-daniel', 'chen-wei'], games: [[11, 9], [11, 8], [11, 13], [11, 7]], change: [7, -7] },
  { id: 'm10', date: '2026-10-20', event: 'League · Division 2', players: ['moreau-elodie', 'patel-meera'], games: [[11, 7], [11, 5], [11, 8]], change: [6, -6] },
  { id: 'm9', date: '2026-10-15', event: 'Club night', players: ['patel-meera', 'park-jiho'], games: [[11, 9], [12, 10], [11, 8]], change: [11, -11] },
  { id: 'm8', date: '2026-10-15', event: 'Club night', players: ['johansen-annika', 'ali-rashid'], games: [[11, 4], [11, 6], [11, 9]], change: [3, -3] },
  { id: 'm7', date: '2026-10-13', event: 'League · Division 2', players: ['chen-wei', 'lindqvist-erik'], games: [[11, 7], [11, 9], [11, 6]], change: [4, -4] },
  { id: 'm6', date: '2026-10-08', event: 'Club night', players: ['ali-rashid', 'patel-meera'], games: [[8, 11], [11, 9], [9, 11], [11, 13]], change: [-10, 10] },
  { id: 'm5', date: '2026-10-08', event: 'Club night', players: ['nguyen-thanh', 'wojcik-agnieszka'], games: [[11, 9], [9, 11], [11, 8], [11, 9]], change: [7, -7] },
  { id: 'm4', date: '2026-10-06', event: 'League · Division 2', players: ['fernandez-marisol', 'nguyen-linh'], games: [[11, 8], [11, 6], [8, 11], [11, 7]], change: [6, -6] },
  { id: 'm3', date: '2026-10-01', event: 'Club night', players: ['patel-meera', 'chen-wei'], games: [[11, 9], [11, 8], [9, 11], [11, 6]], change: [14, -14] },
  { id: 'm2', date: '2026-10-01', event: 'Club night', players: ['okafor-daniel', 'moreau-elodie'], games: [[9, 11], [11, 7], [11, 6], [11, 8]], change: [6, -6] },
  { id: 'm1', date: '2026-09-29', event: 'League · Division 2', players: ['park-jiho', 'lindqvist-erik'], games: [[11, 6], [11, 9], [11, 4]], change: [4, -4] },
]

const byId = new Map(players.map((player) => [player.id, player]))

export const findPlayer = (id: string): Player | undefined => byId.get(id)
export const viewer = byId.get(VIEWER_ID)!

export const gamesWon = (games: readonly GameScore[]) => games.filter(([a, b]) => a > b).length

// A player's results, newest first, each with the rating it left them on.
export function resultsOf(player: Player): Result[] {
  let rating = player.rating
  const results: Result[] = []
  for (const match of matches) {
    const side = match.players.indexOf(player.id)
    if (side === -1) continue
    const games = match.games.map(([a, b]): GameScore => (side === 0 ? [a, b] : [b, a]))
    results.push({
      id: match.id,
      date: match.date,
      event: match.event,
      opponent: byId.get(match.players[side === 0 ? 1 : 0])!,
      games,
      won: gamesWon(games) > games.length - gamesWon(games),
      change: match.change[side],
      ratingAfter: rating,
    })
    rating -= match.change[side]
  }
  return results
}

export type WinLoss = { won: number; lost: number }

export const recordOf = (results: readonly Result[]): WinLoss => ({
  won: results.filter((r) => r.won).length,
  lost: results.filter((r) => !r.won).length,
})

// The viewer's results against `other`, newest first.
export const headToHead = (other: Player) =>
  resultsOf(viewer).filter((result) => result.opponent.id === other.id)

// Every opponent a player has met, with their record against each, most
// played first.
export function opponentsOf(player: Player) {
  const groups = new Map<string, Result[]>()
  for (const result of resultsOf(player)) {
    groups.set(result.opponent.id, [...(groups.get(result.opponent.id) ?? []), result])
  }
  return [...groups.values()]
    .map((results) => ({ opponent: results[0].opponent, results, ...recordOf(results) }))
    .sort((a, b) => b.results.length - a.results.length)
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
export const shortDate = (iso: string) => dateFormat.format(new Date(`${iso}T12:00:00`))

export const score = (games: readonly GameScore[]) => `${gamesWon(games)}–${games.length - gamesWon(games)}`
export const gameLine = (games: readonly GameScore[]) => games.map(([a, b]) => `${a}–${b}`).join('  ')
