// The sample players the mockups show. The API has no list of players yet,
// so these stand in for its answer. A guest keeps the default display name,
// and a verified player may have chosen another. A player has no rating of
// their own: each league they play in rates them on its own.

export type PlayerKind = 'guest' | 'verified'

export type League = { id: string; name: string }

export const leagues: readonly League[] = [
  { id: 'riverside-winter', name: 'Riverside winter league' },
  { id: 'northgate-tuesday', name: 'Northgate Tuesday league' },
  { id: 'city-open', name: 'City open league' },
  { id: 'spring-doubles', name: 'Spring doubles league' },
]

// A player's rating, record and place in one league.
export type Standing = {
  league: League
  rating: number
  wins: number
  losses: number
  // 1 is the highest rating in the league.
  place: number
  // How many players the league rates.
  of: number
}

// One finished match, from the player's side.
export type MatchResult = {
  id: string
  league: League
  opponentId: string
  opponentName: string
  // Games won by the player, then by the opponent.
  games: readonly [number, number]
  ratingChange: number
  playedOn: string
}

export type Player = {
  id: string
  displayName: string
  kind: PlayerKind
  club: string | null
  joinedOn: string
  // The highest rating first. Empty until the player's first league match.
  standings: readonly Standing[]
  // The newest first.
  matches: readonly MatchResult[]
}

type Seed = {
  id: string
  displayName: string
  kind: PlayerKind
  club: string | null
  joinedOn: string
  // League id, rating, wins and losses.
  standings: readonly [string, number, number, number][]
  // League id, opponent id, games won and lost, rating change and date,
  // the newest first.
  results: readonly [string, string, number, number, number, string][]
}

const seeds: readonly Seed[] = [
  {
    id: 'mara-okafor',
    displayName: 'Mara Okafor',
    kind: 'verified',
    club: 'Riverside TTC',
    joinedOn: '2026-03-02',
    standings: [
      ['riverside-winter', 1912, 30, 8],
      ['city-open', 1840, 11, 4],
    ],
    results: [
      ['city-open', 'tomas-lindqvist', 3, 1, 9, '2026-10-24'],
      ['city-open', 'excited-egret-387', 3, 0, 4, '2026-10-21'],
      ['riverside-winter', 'priya-raman', 2, 3, -11, '2026-10-18'],
      ['riverside-winter', 'hana-sato', 3, 0, 2, '2026-10-12'],
      ['city-open', 'calm-crane-214', 3, 0, 3, '2026-10-05'],
    ],
  },
  {
    id: 'priya-raman',
    displayName: 'Priya Raman',
    kind: 'verified',
    club: 'Riverside TTC',
    joinedOn: '2026-03-14',
    standings: [
      ['riverside-winter', 1878, 25, 10],
      ['city-open', 1795, 12, 5],
    ],
    results: [
      ['riverside-winter', 'hana-sato', 3, 1, 5, '2026-10-23'],
      ['riverside-winter', 'mara-okafor', 3, 2, 11, '2026-10-18'],
      ['city-open', 'tomas-lindqvist', 1, 3, -12, '2026-10-11'],
    ],
  },
  {
    id: 'tomas-lindqvist',
    displayName: 'Tomas Lindqvist',
    kind: 'verified',
    club: 'Northgate Spin',
    joinedOn: '2026-04-01',
    standings: [
      ['northgate-tuesday', 1844, 20, 9],
      ['city-open', 1720, 9, 5],
    ],
    results: [
      ['city-open', 'mara-okafor', 1, 3, -9, '2026-10-24'],
      ['city-open', 'bright-bison-552', 3, 0, 3, '2026-10-20'],
      ['northgate-tuesday', 'jun-park', 3, 2, 7, '2026-10-12'],
      ['city-open', 'priya-raman', 3, 1, 12, '2026-10-11'],
    ],
  },
  {
    id: 'jun-park',
    displayName: 'Jun Park',
    kind: 'verified',
    club: 'Northgate Spin',
    joinedOn: '2026-03-20',
    standings: [['northgate-tuesday', 1790, 33, 22]],
    results: [
      ['northgate-tuesday', 'aleksandra-wisniewska-kowalczyk', 1, 3, -8, '2026-10-23'],
      ['northgate-tuesday', 'samuel-adeyemi', 3, 1, 6, '2026-10-16'],
      ['northgate-tuesday', 'tomas-lindqvist', 2, 3, -7, '2026-10-12'],
    ],
  },
  {
    id: 'excited-egret-387',
    displayName: 'excited egret 387',
    kind: 'guest',
    club: null,
    joinedOn: '2026-08-09',
    standings: [['city-open', 1702, 18, 11]],
    results: [
      ['city-open', 'mara-okafor', 0, 3, -4, '2026-10-21'],
      ['city-open', 'calm-crane-214', 3, 2, 10, '2026-10-14'],
    ],
  },
  {
    id: 'aleksandra-wisniewska-kowalczyk',
    displayName: 'Aleksandra Wiśniewska-Kowalczyk',
    kind: 'verified',
    club: 'Old Town Table Tennis and Social Club',
    joinedOn: '2026-05-11',
    standings: [
      ['northgate-tuesday', 1688, 12, 11],
      ['riverside-winter', 1610, 10, 8],
    ],
    results: [
      ['northgate-tuesday', 'jun-park', 3, 1, 8, '2026-10-23'],
      ['riverside-winter', 'hana-sato', 2, 3, -9, '2026-10-09'],
    ],
  },
  {
    id: 'bright-bison-552',
    displayName: 'bright bison 552',
    kind: 'guest',
    club: null,
    joinedOn: '2026-09-02',
    standings: [['city-open', 1615, 12, 13]],
    results: [
      ['city-open', 'tomas-lindqvist', 0, 3, -3, '2026-10-20'],
      ['city-open', 'lucky-lynx-905', 3, 1, 7, '2026-10-17'],
    ],
  },
  {
    id: 'samuel-adeyemi',
    displayName: 'Samuel Adeyemi',
    kind: 'verified',
    club: 'Old Town Table Tennis and Social Club',
    joinedOn: '2026-06-23',
    standings: [['northgate-tuesday', 1583, 15, 17]],
    results: [['northgate-tuesday', 'jun-park', 1, 3, -6, '2026-10-16']],
  },
  {
    id: 'lucky-lynx-905',
    displayName: 'lucky lynx 905',
    kind: 'guest',
    club: null,
    joinedOn: '2026-09-15',
    standings: [['city-open', 1540, 9, 12]],
    results: [
      ['city-open', 'bright-bison-552', 1, 3, -7, '2026-10-17'],
      ['city-open', 'calm-crane-214', 3, 2, 9, '2026-10-09'],
    ],
  },
  {
    id: 'calm-crane-214',
    displayName: 'calm crane 214',
    kind: 'guest',
    club: null,
    joinedOn: '2026-09-28',
    standings: [['city-open', 1466, 4, 9]],
    results: [
      ['city-open', 'excited-egret-387', 2, 3, -10, '2026-10-14'],
      ['city-open', 'lucky-lynx-905', 2, 3, -9, '2026-10-09'],
      ['city-open', 'mara-okafor', 0, 3, -3, '2026-10-05'],
    ],
  },
  {
    id: 'hana-sato',
    displayName: 'Hana Sato',
    kind: 'verified',
    club: 'Riverside TTC',
    joinedOn: '2026-10-01',
    standings: [['riverside-winter', 1421, 3, 6]],
    results: [
      ['riverside-winter', 'priya-raman', 1, 3, -5, '2026-10-23'],
      ['riverside-winter', 'mara-okafor', 0, 3, -2, '2026-10-12'],
      ['riverside-winter', 'aleksandra-wisniewska-kowalczyk', 3, 2, 9, '2026-10-09'],
    ],
  },
  {
    id: 'gentle-gecko-640',
    displayName: 'gentle gecko 640',
    kind: 'guest',
    club: null,
    joinedOn: '2026-10-25',
    standings: [],
    results: [],
  },
]

const names = new Map(seeds.map((seed) => [seed.id, seed.displayName]))
const leagueById = new Map(leagues.map((league) => [league.id, league]))

// Each league's ratings, the highest first, to place every player in it.
const ratingsByLeague = new Map(
  leagues.map((league) => [
    league.id,
    seeds
      .flatMap((seed) => seed.standings.filter(([id]) => id === league.id))
      .map(([, rating]) => rating)
      .sort((a, b) => b - a),
  ]),
)

export const samplePlayers: readonly Player[] = seeds.map(
  ({ standings, results, ...player }) => ({
    ...player,
    standings: standings
      .map(([leagueId, rating, wins, losses]) => {
        const ratings = ratingsByLeague.get(leagueId)!
        return {
          league: leagueById.get(leagueId)!,
          rating,
          wins,
          losses,
          place: ratings.indexOf(rating) + 1,
          of: ratings.length,
        }
      })
      .sort((a, b) => b.rating - a.rating),
    matches: results.map(
      ([leagueId, opponentId, won, lost, ratingChange, playedOn], index) => ({
        id: `${player.id}-${index}`,
        league: leagueById.get(leagueId)!,
        opponentId,
        opponentName: names.get(opponentId) ?? opponentId,
        games: [won, lost] as const,
        ratingChange,
        playedOn,
      }),
    ),
  }),
)

export type Rung = { player: Player; standing: Standing }

// The players a league rates, by place.
export function ladder(players: readonly Player[], leagueId: string): Rung[] {
  return players
    .flatMap((player) =>
      player.standings
        .filter((standing) => standing.league.id === leagueId)
        .map((standing) => ({ player, standing })),
    )
    .sort((a, b) => a.standing.place - b.standing.place)
}

export function record(player: Player): { wins: number; losses: number } {
  return player.standings.reduce(
    (total, { wins, losses }) => ({
      wins: total.wins + wins,
      losses: total.losses + losses,
    }),
    { wins: 0, losses: 0 },
  )
}

export function leagueCount(player: Player): string {
  const count = player.standings.length
  if (count === 0) return 'No leagues yet'
  return count === 1 ? '1 league' : `${count} leagues`
}

export function lastPlayedOn(player: Player): string | null {
  return player.matches[0]?.playedOn ?? null
}

// The rating change of the player's latest match in the league, or null.
export function lastChangeIn(player: Player, leagueId: string): number | null {
  return player.matches.find((match) => match.league.id === leagueId)?.ratingChange ?? null
}

// The share of matches won, as a whole percent, or null with no matches.
export function winRate({ wins, losses }: { wins: number; losses: number }): number | null {
  const played = wins + losses
  return played ? Math.round((wins / played) * 100) : null
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export function formatDate(isoDate: string): string {
  return dateFormat.format(new Date(`${isoDate}T12:00:00`))
}

const ordinalRules = new Intl.PluralRules('en', { type: 'ordinal' })
const ordinalSuffixes: Record<Intl.LDMLPluralRule, string> = {
  zero: 'th',
  one: 'st',
  two: 'nd',
  few: 'rd',
  many: 'th',
  other: 'th',
}

// A place as a word, such as `1st` or `22nd`.
export function ordinal(place: number): string {
  return `${place}${ordinalSuffixes[ordinalRules.select(place)]}`
}
