// The design system page's sample tournament day, typed from the reference's
// match.js (references/design-system/ui_kits/components/match.js), which the
// gallery's match parts are drawn from.

// One player's side of a match: 0 is the first player listed, 1 the second.
export type Side = 0 | 1

// A game's points, the first player's first.
export type GameScore = readonly [number, number]

// `short` is the name a schedule block or game table shows, when it isn't
// the family name before the comma (e.g. a doubles pair). Not every player
// has a club.
export type MatchPlayer = { name: string; club?: string; short?: string }

export type Rest = { who: string; until: string }

export type Conflict = {
  short: string
  title: string
  body: string
  fix: string
  kept: string
}

type Slot = { id: string; table: number; start: string; end: string }

type Contest = Slot & {
  event: string
  round: string
  players: readonly [MatchPlayer, MatchPlayer]
  // Every game started, the one in play last.
  games: readonly GameScore[]
}

export type UpcomingMatch = Contest & {
  state: 'upcoming'
  called?: boolean
  rest?: Rest
}
export type LiveMatch = Contest & { state: 'live'; serve: Side }
export type OfflineMatch = Contest & {
  state: 'offline'
  serve: Side
  offlineSince: string
}
export type FinalMatch = Contest & { state: 'final' }
export type ConflictMatch = Contest & { state: 'conflict'; conflict: Conflict }

export type Match =
  | UpcomingMatch
  | LiveMatch
  | OfflineMatch
  | FinalMatch
  | ConflictMatch

// A gap in a table's schedule. It has no players, so it isn't a Match.
export type FreeSlot = Slot & { state: 'free' }

export type Day = {
  from: string
  to: string
  now: string
  tables: readonly number[]
  slots: readonly (Match | FreeSlot)[]
}

// The scores a match shows: the games finished, the game in play (live or
// offline matches only), the games each side won, and the winner of a final.
export type MatchScore = {
  done: readonly GameScore[]
  current: GameScore | null
  won: readonly [number, number]
  winner: Side | null
}

export function matchScore(match: Match): MatchScore {
  const { games } = match
  const inPlay =
    (match.state === 'live' || match.state === 'offline') && games.length > 0
  const done = inPlay ? games.slice(0, -1) : games
  const current = inPlay ? games[games.length - 1] : null
  const wins = (side: Side) =>
    done.filter((game) => game[side] > game[side === 0 ? 1 : 0]).length
  const won = [wins(0), wins(1)] as const
  const winner = match.state === 'final' ? (won[0] > won[1] ? 0 : 1) : null
  return { done, current, won, winner }
}

// Whether a match has a game in play, so it shows the points and the server.
export function isScored(match: Match): match is LiveMatch | OfflineMatch {
  return match.state === 'live' || match.state === 'offline'
}

// The minutes since midnight of a time of day such as "10:30".
export function minutes(time: string): number {
  const [hours, mins] = time.split(':').map(Number)
  return hours * 60 + mins
}

// The time of day `count` minutes after midnight, such as "10:30".
export function clockTime(count: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(count / 60))}:${pad(count % 60)}`
}

export function shortName(player: MatchPlayer): string {
  return player.short ?? player.name.split(',')[0]
}

const player = (name: string, club: string, short?: string): MatchPlayer =>
  short ? { name, club, short } : { name, club }

export const day: Day = {
  from: '10:30',
  to: '13:00',
  now: '11:47',
  tables: [1, 2, 3, 4],
  slots: [
    { id: 'a1', table: 1, state: 'final', start: '10:30', end: '11:05', event: 'Open singles', round: 'Round of 32', players: [player('Nguyen, Thanh', 'Riverside TT'), player('Silva, Rafael', 'Northside')], games: [[11, 7], [9, 11], [11, 8], [11, 6]] },
    { id: 'a2', table: 1, state: 'live', start: '11:10', end: '11:45', event: 'Open singles', round: 'Round of 16', serve: 0, players: [player('Okafor-Adeyemi, Daniel', 'Eastgate'), player('Johansen-Whitfield, Annika', 'Northside')], games: [[11, 9], [8, 11], [11, 6], [8, 6]] },
    { id: 'a3', table: 1, state: 'upcoming', start: '12:00', end: '12:35', event: 'Open singles', round: 'Round of 16', players: [player('Chen, Wei', 'Riverside TT'), player('Ali, Rashid', 'Eastgate')], games: [] },
    { id: 'b1', table: 2, state: 'final', start: '10:30', end: '11:00', event: 'Under 18 singles', round: 'Quarterfinal', players: [player('Lindqvist, Erik', 'Northside'), player('Haddad, Youssef', 'Riverside TT')], games: [[11, 5], [11, 8], [11, 4]] },
    { id: 'b2', table: 2, state: 'free', start: '11:05', end: '11:45' },
    { id: 'b3', table: 2, state: 'conflict', start: '11:50', end: '12:25', event: 'Open singles', round: 'Round of 16', players: [player('Patel, Meera', 'Riverside TT'), player('Park, Ji-ho', 'Eastgate')], games: [], conflict: { short: 'Patel would rest 5 min', title: 'Patel would get 5 minutes’ rest', body: 'Her match on Table 3 is running 10 minutes over. Starting at 12:05 keeps the 15-minute minimum.', fix: 'Move to 12:05', kept: 'Kept at 11:50 by the organizer. Patel gets 5 minutes’ rest, under the 15-minute minimum.' } },
    { id: 'c1', table: 3, state: 'final', start: '10:30', end: '11:05', event: 'Open singles', round: 'Round of 32', players: [player('Moreau, Élodie', 'Eastgate'), player('Kim, Hyun-woo', 'Northside')], games: [[11, 9], [7, 11], [11, 13], [11, 8], [12, 10]] },
    { id: 'c2', table: 3, state: 'live', start: '11:05', end: '11:45', event: 'Open singles', round: 'Round of 32', serve: 1, players: [player('Patel, Meera', 'Riverside TT'), player('Wójcik-Szymańska, Agnieszka', 'Northside')], games: [[11, 8], [6, 11], [11, 9], [9, 11], [9, 9]] },
    { id: 'c3', table: 3, state: 'upcoming', start: '12:15', end: '12:50', event: 'Under 18 singles', round: 'Semifinal', players: [player('Dubois, Camille', 'Eastgate'), player('Lindqvist, Erik', 'Northside')], games: [], rest: { who: 'Lindqvist', until: '12:10' } },
    { id: 'd1', table: 4, state: 'offline', start: '11:00', end: '11:40', event: 'Open doubles', round: 'Quarterfinal', serve: 1, offlineSince: '11:42', players: [player('Rossi, Giulia / Haddad, Youssef', 'Riverside TT', 'Rossi / Haddad'), player('Fernández-Castillo, Marisol / Kim, Hyun-woo', 'Northside', 'Fernández-Castillo / Kim')], games: [[11, 7], [5, 11], [4, 7]] },
    { id: 'd2', table: 4, state: 'upcoming', start: '12:05', end: '12:40', event: 'Open singles', round: 'Round of 16', players: [player('Moreau, Élodie', 'Eastgate'), player('Silva, Rafael', 'Northside')], games: [] },
  ],
}

// The match with the id `id` in the sample day. It throws for a free slot or
// an unknown id, so callers get a Match.
export function findMatch(id: string): Match {
  const slot = day.slots.find((s) => s.id === id)
  if (!slot || slot.state === 'free') throw new Error(`No match "${id}" in the sample day`)
  return slot
}
