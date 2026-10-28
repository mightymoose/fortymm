// Example data and a simulated API for /login-gate2. Nothing here talks to
// the real API.

export type Gate2Match = {
  id: string
  opponent: string
  won: boolean
  score: string
  date: string
  time: string
}

// A player that a sign-in brought to the account: one open question.
export type SourcePlayer = {
  id: string
  name: string
  // Every match the player played, and the dates of the first and the last.
  total: number
  range: string
  // The 3 newest matches. The rest load only in the history view.
  recent: readonly Gate2Match[]
}

// A player the account already manages, as the picker shows it: its match
// count and its last match, so the person can tell who it is.
export type ManagedPlayer = { id: string; name: string; total: number; lastMatch: string }

export type Gate2Account = {
  // The account's own player. A first sign-in has none yet.
  main: string | null
  // Managed players that a question can merge into. Players with an open
  // question and merged players are never here.
  managed: readonly ManagedPlayer[]
}

export type Scenario = {
  account: Gate2Account
  // Oldest question first.
  queue: readonly SourcePlayer[]
  // The first save fails, so the frame can show the error and the retry.
  failFirstSave?: boolean
  // The first fetch of this history page fails.
  failPage?: number
}

// The number of matches the question shows before "View all".
export const SHOWN = 3

// The number of matches the simulated API returns per page.
export const PAGE = 20

// How long a simulated request takes, in milliseconds.
export const LATENCY = 700

const opponents = [
  'Lin Wei',
  'Ama Okafor',
  'Jonas Berg',
  'Priya Nair',
  'Sam Ortiz',
  'Mei Tanaka',
  'Tomás Reyes',
]
const wins = ['3–1', '3–0', '3–2']
const losses = ['1–3', '2–3', '0–3']
const times = ['19:40', '18:55', '20:10']

// `count` matches, newest first, from `last` back about one a day, each with
// a stable id.
function history(id: string, count: number, last: Date): Gate2Match[] {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(last)
    day.setUTCDate(last.getUTCDate() - Math.floor(index * 1.15))
    const won = index % 3 !== 1
    return {
      id: `${id}-${count - index}`,
      opponent: opponents[index % opponents.length],
      won,
      score: won ? wins[index % 3] : losses[index % 3],
      date: day.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      time: times[index % 3],
    }
  })
}

// What the simulated server holds: every player's whole history.
const histories = new Map<string, Gate2Match[]>()

// A source player and its history. `firstOpponents` replaces the opponents
// of its newest matches, for long names.
function source(
  id: string,
  name: string,
  total: number,
  last: Date,
  firstOpponents: readonly string[] = [],
): SourcePlayer {
  const matches = history(id, total, last).map((match, index) =>
    index < firstOpponents.length ? { ...match, opponent: firstOpponents[index] } : match,
  )
  histories.set(id, matches)
  return { id, name, total, range: range(matches), recent: matches.slice(0, SHOWN) }
}

// The dates of a history, oldest first: "Oct 27", "Oct 25–27" or
// "Sep 3–Oct 27".
function range(matches: readonly Gate2Match[]): string {
  const [newMonth, newDay] = monthDay(matches[0])
  const [oldMonth, oldDay] = monthDay(matches[matches.length - 1])
  if (oldMonth === newMonth) return oldDay === newDay ? `${newMonth} ${newDay}` : `${newMonth} ${oldDay}–${newDay}`
  return `${oldMonth} ${oldDay}–${newMonth} ${newDay}`
}

// "Tue, Oct 27" as ["Oct", "27"].
function monthDay(match: Gate2Match): [string, string] {
  const [month, day] = match.date.split(', ')[1].split(' ')
  return [month, day]
}

const oct27 = new Date(Date.UTC(2026, 9, 27))

export const mellow = source('mellow', 'mellow mongoose 594', 3, oct27)
export const badger = source('badger', 'brave badger 214', 12, oct27)
export const heron = source('heron', 'hardy heron 233', 48, oct27)
export const hummingbird = source('hummingbird', 'harmonious hummingbird 908', 12, oct27, [
  'Oluwaseun Adeyemi-Fitzgerald',
  'Maximiliane Hohenberger',
])

export const mainPlayer = 'excited egret 387'

export const managedPlayers: readonly ManagedPlayer[] = [
  { id: 'koala', name: 'kindly koala 552', total: 14, lastMatch: 'Ama Okafor on Oct 20' },
  { id: 'bobcat', name: 'blithe bobcat 172', total: 6, lastMatch: 'Mei Tanaka on Sep 28' },
]

// The first `pages` pages of a player's history at once, for a frame that
// starts with them loaded.
export function serverPages(playerId: string, pages: number): { rows: Gate2Match[]; next: number | null } {
  const all = histories.get(playerId) ?? []
  return { rows: all.slice(0, pages * PAGE), next: pages * PAGE < all.length ? pages : null }
}

// One page of a player's history, newest first, after LATENCY. `fail`
// rejects it instead.
export function fetchMatches(
  playerId: string,
  page: number,
  fail: boolean,
): Promise<{ rows: Gate2Match[]; next: number | null }> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (fail) {
        reject(new Error('Simulated failure'))
        return
      }
      const all = histories.get(playerId) ?? []
      const rows = all.slice(page * PAGE, (page + 1) * PAGE)
      resolve({ rows, next: (page + 1) * PAGE < all.length ? page + 1 : null })
    }, LATENCY)
  })
}

export function matchCount(total: number): string {
  return total === 1 ? '1 match' : `${total} matches`
}

// "All 12 matches" when the question shows only some of them.
function scope(player: SourcePlayer): string {
  if (player.total === 1) return 'This match'
  return player.total > SHOWN ? `All ${player.total} matches` : `These ${player.total} matches`
}

// The sentence above the answers: what Yes does. Yes always merges into the
// account's main player, which keeps its name.
export function outcome(player: SourcePlayer, account: Gate2Account): string {
  return account.main
    ? `${scope(player)} will be added to ${account.main}.`
    : `${scope(player)} will be saved to your account under ${player.name}.`
}
