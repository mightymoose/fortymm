// Sample matches for the match list and match page prototypes. The API
// doesn't list or read matches yet, so every variant draws these.

export type Side = 0 | 1
export type GameScore = readonly [number, number]
export type BestOf = 1 | 3 | 5 | 7

export type MatchPlayer = { name: string; you?: boolean }

// One step in the match's history: who did what, and when.
export type MatchEvent = { at: string; who: string; what: string }

// `live`: someone is keeping score on the board, and the last game is in play.
// `awaiting`: one side signed the scores and the other side hasn't yet.
// `disputed`: the sides signed different scores. `theirGames` is what the
// other side signed, `games` what `signedBy` signed.
// `final`: both sides approved. A rated match moves each side's rating.
export type MatchStatus =
  | { kind: 'live'; serve: Side }
  | { kind: 'awaiting'; signedBy: Side; signedAt: string }
  | { kind: 'disputed'; signedBy: Side; theirGames: readonly GameScore[] }
  | { kind: 'final'; approvedAt: string; rating: readonly [number, number] | null }

export type MatchRecord = {
  id: string
  bestOf: BestOf
  rated: boolean
  players: readonly [MatchPlayer, MatchPlayer]
  games: readonly GameScore[]
  startedAt: string
  status: MatchStatus
  history: readonly MatchEvent[]
}

export const YOU = 'Alex Rivera'

const you: MatchPlayer = { name: YOU, you: true }
const p = (name: string): MatchPlayer => ({ name })

export const sampleMatches: readonly MatchRecord[] = [
  {
    id: '0193f1a2-live-0001',
    bestOf: 5,
    rated: true,
    players: [you, p('Wei Chen')],
    games: [[11, 8], [9, 11], [7, 5]],
    startedAt: '2026-11-05T19:12:00',
    status: { kind: 'live', serve: 1 },
    history: [
      { at: '2026-11-05T19:12:00', who: YOU, what: 'Started the match' },
      { at: '2026-11-05T19:21:00', who: 'Wei Chen', what: 'Entered game 1, 11–8' },
      { at: '2026-11-05T19:30:00', who: 'Jordan Patel', what: 'Entered game 2, 9–11' },
    ],
  },
  {
    id: '0193f1a2-await-0002',
    bestOf: 3,
    rated: true,
    players: [p('Meera Okafor'), you],
    games: [[11, 6], [8, 11], [11, 9]],
    startedAt: '2026-11-05T18:05:00',
    status: { kind: 'awaiting', signedBy: 0, signedAt: '2026-11-05T18:41:00' },
    history: [
      { at: '2026-11-05T18:05:00', who: 'Meera Okafor', what: 'Started the match' },
      { at: '2026-11-05T18:38:00', who: YOU, what: 'Entered game 3, 11–9' },
      { at: '2026-11-05T18:41:00', who: 'Meera Okafor', what: 'Signed the result, 2–1' },
    ],
  },
  {
    id: '0193f1a2-disp-0003',
    bestOf: 5,
    rated: false,
    players: [you, p('Rafael Silva')],
    games: [[11, 7], [11, 9], [6, 11], [12, 10]],
    startedAt: '2026-11-04T20:10:00',
    status: { kind: 'disputed', signedBy: 0, theirGames: [[11, 7], [9, 11], [6, 11], [12, 10], [8, 11]] },
    history: [
      { at: '2026-11-04T20:10:00', who: YOU, what: 'Started the match' },
      { at: '2026-11-04T20:52:00', who: YOU, what: 'Signed the result, 3–1' },
      { at: '2026-11-04T21:03:00', who: 'Rafael Silva', what: 'Signed different scores, 2–3' },
    ],
  },
  {
    id: '0193f1a2-final-0004',
    bestOf: 5,
    rated: true,
    players: [you, p('Annika Johansen-Whitfield')],
    games: [[11, 9], [8, 11], [11, 6], [11, 4]],
    startedAt: '2026-11-04T19:00:00',
    status: { kind: 'final', approvedAt: '2026-11-04T19:44:00', rating: [12, -12] },
    history: [
      { at: '2026-11-04T19:00:00', who: YOU, what: 'Started the match' },
      { at: '2026-11-04T19:40:00', who: YOU, what: 'Signed the result, 3–1' },
      { at: '2026-11-04T19:44:00', who: 'Annika Johansen-Whitfield', what: 'Approved the result' },
    ],
  },
  {
    id: '0193f1a2-final-0005',
    bestOf: 3,
    rated: true,
    players: [p('Daniel Okafor-Adeyemi'), you],
    games: [[11, 5], [11, 8]],
    startedAt: '2026-11-02T18:30:00',
    status: { kind: 'final', approvedAt: '2026-11-02T18:52:00', rating: [6, -6] },
    history: [
      { at: '2026-11-02T18:30:00', who: 'Daniel Okafor-Adeyemi', what: 'Started the match' },
      { at: '2026-11-02T18:50:00', who: 'Daniel Okafor-Adeyemi', what: 'Signed the result, 2–0' },
      { at: '2026-11-02T18:52:00', who: YOU, what: 'Approved the result' },
    ],
  },
  {
    id: '0193f1a2-final-0006',
    bestOf: 5,
    rated: false,
    players: [you, p('Élodie Moreau')],
    games: [[11, 9], [7, 11], [11, 13], [11, 8], [12, 10]],
    startedAt: '2026-10-29T19:15:00',
    status: { kind: 'final', approvedAt: '2026-10-29T20:05:00', rating: null },
    history: [
      { at: '2026-10-29T19:15:00', who: YOU, what: 'Started the match' },
      { at: '2026-10-29T20:02:00', who: YOU, what: 'Signed the result, 3–2' },
      { at: '2026-10-29T20:05:00', who: 'Élodie Moreau', what: 'Approved the result' },
    ],
  },
]

export function findMatch(id: string): MatchRecord | undefined {
  return sampleMatches.find((match) => match.id === id)
}

const other = (side: Side): Side => (side === 0 ? 1 : 0)

// The games each side has won, the game in play (live only), and the winner
// once the match is final.
export function score(match: MatchRecord) {
  const live = match.status.kind === 'live' && match.games.length > 0
  const done = live ? match.games.slice(0, -1) : match.games
  const current = live ? match.games[match.games.length - 1] : null
  const wins = (side: Side) => done.filter((game) => game[side] > game[other(side)]).length
  const won = [wins(0), wins(1)] as const
  const winner: Side | null = match.status.kind === 'final' ? (won[0] > won[1] ? 0 : 1) : null
  return { done, current, won, winner }
}

export function yourSide(match: MatchRecord): Side | null {
  if (match.players[0].you) return 0
  if (match.players[1].you) return 1
  return null
}

export function opponent(match: MatchRecord): MatchPlayer {
  return match.players[yourSide(match) === 0 ? 1 : 0]
}

// Whether the viewer is the one the match waits on: the other side signed,
// or the sides disagree.
export function needsYou(match: MatchRecord): boolean {
  const side = yourSide(match)
  if (side === null) return false
  if (match.status.kind === 'awaiting') return match.status.signedBy !== side
  return match.status.kind === 'disputed'
}

export const formatLabel = (match: MatchRecord) =>
  `Best of ${match.bestOf} · ${match.rated ? 'Rated' : 'Unrated'}`

const dayFormat = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short' })
const timeFormat = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false })

export const formatDay = (iso: string) => dayFormat.format(new Date(iso))
export const formatTime = (iso: string) => timeFormat.format(new Date(iso))
