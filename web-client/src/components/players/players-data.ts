/**
 * Hardcoded fixture data for the Players list and profile pages.
 *
 * Ported from the design handoff (Players.html / data.jsx). The shape and the
 * 28 players + 19 matches are kept verbatim from the design so what we ship
 * matches the screenshots reviewed with the team. This is intentionally not
 * connected to the API yet — once we have the backend endpoints the page will
 * swap to live data without changing its visual shape.
 */

export type CountryCode = keyof typeof COUNTRIES

export const COUNTRIES = {
  VN: { name: 'Vietnam', flag: '🇻🇳' },
  BR: { name: 'Brazil', flag: '🇧🇷' },
  NG: { name: 'Nigeria', flag: '🇳🇬' },
  NO: { name: 'Norway', flag: '🇳🇴' },
  US: { name: 'United States', flag: '🇺🇸' },
  IN: { name: 'India', flag: '🇮🇳' },
  CN: { name: 'China', flag: '🇨🇳' },
  KR: { name: 'South Korea', flag: '🇰🇷' },
  DE: { name: 'Germany', flag: '🇩🇪' },
  FR: { name: 'France', flag: '🇫🇷' },
  SE: { name: 'Sweden', flag: '🇸🇪' },
  JP: { name: 'Japan', flag: '🇯🇵' },
  IT: { name: 'Italy', flag: '🇮🇹' },
  GB: { name: 'United Kingdom', flag: '🇬🇧' },
  AU: { name: 'Australia', flag: '🇦🇺' },
  EG: { name: 'Egypt', flag: '🇪🇬' },
  CZ: { name: 'Czechia', flag: '🇨🇿' },
  RO: { name: 'Romania', flag: '🇷🇴' },
} as const satisfies Record<string, { name: string; flag: string }>

export const CLUBS = [
  'Vinh TTC',
  'Rio Paddles',
  'Lagos Spin Club',
  'Oslo Topspin',
  'Bay Area TTC',
  'Mumbai Smash',
  'Beijing 21',
  'Seoul Loop',
  'Berlin Backspin',
  'Paris Pivot',
  'Stockholm Serve',
  'Tokyo Chop',
  'Milan Mezzo',
  'London Olympic TTC',
  'Sydney Slice',
  'Cairo Pyramid',
  'Prague Penhold',
  'Bucharest Backhand',
] as const

export type Grip = 'Shakehand' | 'Penhold' | 'Reverse penhold'
export type Style = 'Offensive' | 'All-round' | 'Defensive' | 'Counter-driver'
export type PlayerStatus = 'live' | 'idle' | 'registered' | 'withdrawn'
export type Hand = 'L' | 'R'

export interface Player {
  id: string
  name: string
  country: CountryCode
  club: string
  rating: number
  delta: number
  w: number
  l: number
  seed: number
  hand: Hand
  grip: Grip
  style: Style
  age: number
  status: PlayerStatus
  lastSeen: string
  event: string
  /** 5-char string of 'W' / 'L' for the last 5 matches. */
  form: string
}

export const PLAYERS: Player[] = [
  { id: 'p01', name: 'Thanh Nguyen',     country: 'VN', club: 'Vinh TTC',           rating: 2487, delta:  18, w: 32, l:  6, seed:  1, hand: 'R', grip: 'Shakehand',       style: 'Offensive',      age: 24, status: 'live',       lastSeen: 'now',      event: 'Court 3 · QF',     form: 'WWWLW' },
  { id: 'p02', name: 'Rafael Silva',     country: 'BR', club: 'Rio Paddles',        rating: 2421, delta:  -9, w: 27, l:  9, seed:  2, hand: 'L', grip: 'Shakehand',       style: 'Counter-driver', age: 27, status: 'live',       lastSeen: 'now',      event: 'Court 3 · QF',     form: 'WLWWW' },
  { id: 'p03', name: 'David Okafor',     country: 'NG', club: 'Lagos Spin Club',    rating: 2398, delta:  24, w: 24, l:  8, seed:  3, hand: 'R', grip: 'Shakehand',       style: 'Offensive',      age: 22, status: 'live',       lastSeen: 'now',      event: 'Court 2 · QF',     form: 'WWLWW' },
  { id: 'p04', name: 'Astrid Johansen',  country: 'NO', club: 'Oslo Topspin',       rating: 2386, delta:  11, w: 25, l: 10, seed:  4, hand: 'R', grip: 'Shakehand',       style: 'All-round',      age: 29, status: 'live',       lastSeen: 'now',      event: 'Court 2 · QF',     form: 'WWWWL' },
  { id: 'p05', name: 'Linh Tran',        country: 'VN', club: 'Vinh TTC',           rating: 2354, delta:   6, w: 21, l: 11, seed:  5, hand: 'R', grip: 'Penhold',         style: 'Offensive',      age: 21, status: 'live',       lastSeen: 'now',      event: 'Court 1 · QF',     form: 'WLWWW' },
  { id: 'p06', name: 'Meera Patel',      country: 'IN', club: 'Mumbai Smash',       rating: 2341, delta:  -3, w: 22, l: 12, seed:  6, hand: 'R', grip: 'Shakehand',       style: 'All-round',      age: 23, status: 'live',       lastSeen: 'now',      event: 'Court 1 · QF',     form: 'LWWWL' },
  { id: 'p07', name: 'Wei Chen',         country: 'CN', club: 'Beijing 21',         rating: 2329, delta:  14, w: 19, l:  9, seed:  7, hand: 'R', grip: 'Reverse penhold', style: 'Offensive',      age: 20, status: 'idle',       lastSeen: '2h',       event: 'R16 — won',        form: 'WWWWW' },
  { id: 'p08', name: 'Jisoo Park',       country: 'KR', club: 'Seoul Loop',         rating: 2318, delta: -21, w: 18, l: 13, seed:  8, hand: 'R', grip: 'Penhold',         style: 'Counter-driver', age: 26, status: 'idle',       lastSeen: '2h',       event: 'R16 — lost',       form: 'LLWLW' },
  { id: 'p09', name: 'Hannes Becker',    country: 'DE', club: 'Berlin Backspin',    rating: 2287, delta:   4, w: 17, l: 12, seed:  9, hand: 'L', grip: 'Shakehand',       style: 'Defensive',      age: 31, status: 'idle',       lastSeen: '4h',       event: 'R16 — won',        form: 'WLWWW' },
  { id: 'p10', name: 'Camille Dubois',   country: 'FR', club: 'Paris Pivot',        rating: 2271, delta:   9, w: 16, l: 11, seed: 10, hand: 'R', grip: 'Shakehand',       style: 'All-round',      age: 25, status: 'idle',       lastSeen: '4h',       event: 'R16 — won',        form: 'WWWLW' },
  { id: 'p11', name: 'Erik Lindqvist',   country: 'SE', club: 'Stockholm Serve',    rating: 2243, delta: -12, w: 14, l: 14, seed: 11, hand: 'R', grip: 'Shakehand',       style: 'Offensive',      age: 28, status: 'idle',       lastSeen: '5h',       event: 'R16 — lost',       form: 'LWLLW' },
  { id: 'p12', name: 'Yuki Tanaka',      country: 'JP', club: 'Tokyo Chop',         rating: 2229, delta:   2, w: 15, l: 13, seed: 12, hand: 'R', grip: 'Shakehand',       style: 'Defensive',      age: 33, status: 'idle',       lastSeen: '5h',       event: 'R16 — won',        form: 'WLWLW' },
  { id: 'p13', name: 'Giulia Rossi',     country: 'IT', club: 'Milan Mezzo',        rating: 2204, delta:   0, w: 13, l: 13, seed: 13, hand: 'R', grip: 'Shakehand',       style: 'All-round',      age: 24, status: 'registered', lastSeen: 'tomorrow', event: 'R16 vs Park',      form: 'WWLWW' },
  { id: 'p14', name: 'James Holloway',   country: 'GB', club: 'London Olympic TTC', rating: 2186, delta:  -5, w: 12, l: 13, seed: 14, hand: 'R', grip: 'Shakehand',       style: 'Counter-driver', age: 30, status: 'registered', lastSeen: 'tomorrow', event: 'R16 vs Becker',    form: 'LWLLW' },
  { id: 'p15', name: 'Mia Whitford',     country: 'AU', club: 'Sydney Slice',       rating: 2172, delta:   8, w: 11, l: 12, seed: 15, hand: 'L', grip: 'Shakehand',       style: 'Offensive',      age: 22, status: 'idle',       lastSeen: '1d',       event: 'R32 — won',        form: 'WLWWW' },
  { id: 'p16', name: 'Rana Ali',         country: 'EG', club: 'Cairo Pyramid',      rating: 2154, delta:  15, w: 10, l: 11, seed: 16, hand: 'R', grip: 'Shakehand',       style: 'Offensive',      age: 19, status: 'idle',       lastSeen: '1d',       event: 'R32 — won',        form: 'WWWWL' },
  { id: 'p17', name: 'Tomas Novak',      country: 'CZ', club: 'Prague Penhold',     rating: 2131, delta:  -7, w:  9, l: 13, seed: 17, hand: 'R', grip: 'Penhold',         style: 'Defensive',      age: 35, status: 'idle',       lastSeen: '1d',       event: 'R32 — lost',       form: 'LWLLL' },
  { id: 'p18', name: 'Hyun Kim',         country: 'KR', club: 'Seoul Loop',         rating: 2118, delta:   3, w:  9, l: 11, seed: 18, hand: 'R', grip: 'Shakehand',       style: 'All-round',      age: 23, status: 'registered', lastSeen: 'tomorrow', event: 'R16 vs Tran',      form: 'WWLWW' },
  { id: 'p19', name: 'Sofia Marin',      country: 'BR', club: 'Rio Paddles',        rating: 2089, delta:  -2, w:  8, l: 11, seed: 19, hand: 'R', grip: 'Shakehand',       style: 'Offensive',      age: 26, status: 'idle',       lastSeen: '1d',       event: 'R32 — lost',       form: 'LWLWL' },
  { id: 'p20', name: 'Andrei Popescu',   country: 'RO', club: 'Bucharest Backhand', rating: 2061, delta:  19, w:  8, l: 10, seed: 20, hand: 'L', grip: 'Shakehand',       style: 'Counter-driver', age: 21, status: 'idle',       lastSeen: '2d',       event: 'R32 — won',        form: 'WWLWW' },
  { id: 'p21', name: 'Ben Hayashi',      country: 'US', club: 'Bay Area TTC',       rating: 2034, delta:  -4, w:  7, l: 11, seed: 21, hand: 'R', grip: 'Shakehand',       style: 'All-round',      age: 27, status: 'idle',       lastSeen: '2d',       event: 'R32 — lost',       form: 'WLWLL' },
  { id: 'p22', name: 'Priya Kapoor',     country: 'IN', club: 'Mumbai Smash',       rating: 2018, delta:   6, w:  7, l: 10, seed: 22, hand: 'R', grip: 'Shakehand',       style: 'Offensive',      age: 20, status: 'idle',       lastSeen: '2d',       event: 'R32 — won',        form: 'WWWLW' },
  { id: 'p23', name: 'Luca Bianchi',     country: 'IT', club: 'Milan Mezzo',        rating: 1992, delta:  -1, w:  6, l:  9, seed: 23, hand: 'R', grip: 'Shakehand',       style: 'Defensive',      age: 34, status: 'withdrawn',  lastSeen: '3d',       event: 'Withdrew · injury', form: 'WLLLW' },
  { id: 'p24', name: 'Anna Klein',       country: 'DE', club: 'Berlin Backspin',    rating: 1974, delta:  12, w:  6, l:  8, seed: 24, hand: 'R', grip: 'Shakehand',       style: 'All-round',      age: 18, status: 'registered', lastSeen: 'tomorrow', event: 'R16 vs Whitford',  form: 'WWLWW' },
  { id: 'p25', name: 'Marcus Dane',      country: 'GB', club: 'London Olympic TTC', rating: 1953, delta:   0, w:  5, l:  9, seed: 25, hand: 'R', grip: 'Shakehand',       style: 'Counter-driver', age: 32, status: 'idle',       lastSeen: '2d',       event: 'R32 — lost',       form: 'WLLLW' },
  { id: 'p26', name: 'Nora Sato',        country: 'JP', club: 'Tokyo Chop',         rating: 1928, delta:  -8, w:  4, l:  9, seed: 26, hand: 'L', grip: 'Shakehand',       style: 'Defensive',      age: 29, status: 'idle',       lastSeen: '2d',       event: 'R32 — lost',       form: 'LLWLL' },
  { id: 'p27', name: 'Owen Becker',      country: 'AU', club: 'Sydney Slice',       rating: 1902, delta:   3, w:  4, l:  7, seed: 27, hand: 'R', grip: 'Shakehand',       style: 'All-round',      age: 24, status: 'idle',       lastSeen: '3d',       event: 'R64 — won',        form: 'WLWWL' },
  { id: 'p28', name: 'Karima Said',      country: 'EG', club: 'Cairo Pyramid',      rating: 1881, delta:  10, w:  3, l:  7, seed: 28, hand: 'R', grip: 'Shakehand',       style: 'Offensive',      age: 19, status: 'registered', lastSeen: 'tomorrow', event: 'R16 vs Ali',       form: 'WLWWW' },
]

export type MatchResult = 'W' | 'L'

export interface MatchRecord {
  id: string
  date: string
  time: string
  tournament: string
  round: string
  /** Opponent player id (`PLAYERS[i].id`). */
  opp: string
  oppRating: number
  /** Set scores from the headline player's perspective: `[mine, theirs]`. */
  sets: [number, number][]
  result: MatchResult
  delta: number
  court: number
  duration: string
}

// Matches are written from the headline player (p01)'s perspective. For the
// MVP we render the same list on every profile so the page never reads empty —
// the design handoff only seeded matches for one player.
export const MATCHES: MatchRecord[] = [
  { id: 'm01', date: '2026-05-23', time: '14:30', tournament: 'Spring Open',       round: 'QF',    opp: 'p02', oppRating: 2421, sets: [[11, 7], [9, 11], [11, 5], [11, 8]],          result: 'W', delta:  18, court: 3, duration: '38m' },
  { id: 'm02', date: '2026-05-23', time: '09:45', tournament: 'Spring Open',       round: 'R16',   opp: 'p11', oppRating: 2243, sets: [[11, 4], [11, 6], [11, 9]],                    result: 'W', delta:   9, court: 1, duration: '22m' },
  { id: 'm03', date: '2026-05-22', time: '19:10', tournament: 'Spring Open',       round: 'R32',   opp: 'p20', oppRating: 2061, sets: [[11, 8], [11, 6], [11, 7]],                    result: 'W', delta:   6, court: 4, duration: '24m' },
  { id: 'm04', date: '2026-05-22', time: '11:00', tournament: 'Spring Open',       round: 'R64',   opp: 'p27', oppRating: 1902, sets: [[11, 3], [11, 5], [11, 4]],                    result: 'W', delta:   3, court: 6, duration: '18m' },
  { id: 'm05', date: '2026-05-09', time: '16:20', tournament: 'North Cup',         round: 'Final', opp: 'p03', oppRating: 2398, sets: [[11, 9], [8, 11], [11, 7], [7, 11], [11, 9]],  result: 'W', delta:  22, court: 1, duration: '52m' },
  { id: 'm06', date: '2026-05-09', time: '13:00', tournament: 'North Cup',         round: 'SF',    opp: 'p07', oppRating: 2329, sets: [[11, 8], [11, 5], [9, 11], [11, 7]],           result: 'W', delta:  12, court: 1, duration: '41m' },
  { id: 'm07', date: '2026-05-08', time: '17:45', tournament: 'North Cup',         round: 'QF',    opp: 'p12', oppRating: 2229, sets: [[11, 6], [11, 8], [11, 9]],                    result: 'W', delta:   7, court: 2, duration: '29m' },
  { id: 'm08', date: '2026-05-08', time: '10:30', tournament: 'North Cup',         round: 'R16',   opp: 'p15', oppRating: 2172, sets: [[11, 4], [11, 7], [11, 5]],                    result: 'W', delta:   4, court: 3, duration: '23m' },
  { id: 'm09', date: '2026-04-26', time: '18:00', tournament: 'City League · W17', round: 'Final', opp: 'p04', oppRating: 2386, sets: [[9, 11], [11, 8], [11, 6], [8, 11], [9, 11]],  result: 'L', delta: -14, court: 1, duration: '58m' },
  { id: 'm10', date: '2026-04-25', time: '14:15', tournament: 'City League · W17', round: 'SF',    opp: 'p09', oppRating: 2287, sets: [[11, 9], [11, 8], [11, 7]],                    result: 'W', delta:  11, court: 1, duration: '34m' },
  { id: 'm11', date: '2026-04-11', time: '19:30', tournament: 'Vinh Invitational', round: 'Final', opp: 'p06', oppRating: 2341, sets: [[11, 6], [11, 8], [11, 4]],                    result: 'W', delta:  15, court: 1, duration: '32m' },
  { id: 'm12', date: '2026-04-11', time: '16:00', tournament: 'Vinh Invitational', round: 'SF',    opp: 'p10', oppRating: 2271, sets: [[11, 7], [8, 11], [11, 6], [11, 8]],           result: 'W', delta:   8, court: 2, duration: '37m' },
  { id: 'm13', date: '2026-03-28', time: '15:00', tournament: 'Spring Qualifier',  round: 'R8',    opp: 'p18', oppRating: 2118, sets: [[11, 8], [11, 9], [11, 5]],                    result: 'W', delta:   4, court: 3, duration: '26m' },
  { id: 'm14', date: '2026-03-14', time: '13:40', tournament: 'Friendly',          round: 'Match', opp: 'p08', oppRating: 2318, sets: [[8, 11], [11, 9], [6, 11], [11, 7], [7, 11]],  result: 'L', delta: -11, court: 5, duration: '54m' },
  { id: 'm15', date: '2026-03-01', time: '12:00', tournament: 'City League · W11', round: 'Final', opp: 'p05', oppRating: 2354, sets: [[11, 8], [11, 6], [9, 11], [11, 7]],           result: 'W', delta:  13, court: 1, duration: '39m' },
  { id: 'm16', date: '2026-02-22', time: '17:30', tournament: 'Friendly',          round: 'Match', opp: 'p14', oppRating: 2186, sets: [[11, 5], [11, 4], [11, 7]],                    result: 'W', delta:   5, court: 2, duration: '21m' },
  { id: 'm17', date: '2026-02-08', time: '14:20', tournament: 'Winter Cup',        round: 'Final', opp: 'p02', oppRating: 2421, sets: [[8, 11], [11, 9], [7, 11], [6, 11]],           result: 'L', delta: -15, court: 1, duration: '44m' },
  { id: 'm18', date: '2026-01-25', time: '11:50', tournament: 'Winter Cup',        round: 'SF',    opp: 'p03', oppRating: 2398, sets: [[11, 9], [8, 11], [11, 8], [11, 9]],           result: 'W', delta:  17, court: 1, duration: '42m' },
  { id: 'm19', date: '2026-01-12', time: '19:00', tournament: 'City League · W2',  round: 'R16',   opp: 'p22', oppRating: 2018, sets: [[11, 4], [11, 6], [11, 3]],                    result: 'W', delta:   2, court: 4, duration: '19m' },
]

export function findPlayerById(id: string): Player | undefined {
  return PLAYERS.find((p) => p.id === id)
}

/** Case-insensitive lookup by username (the legacy "first name initial" style
 * from the design — we match on the full display name for now). */
export function findPlayerByName(name: string): Player | undefined {
  const n = name.toLowerCase()
  return PLAYERS.find((p) => p.name.toLowerCase() === n)
}
