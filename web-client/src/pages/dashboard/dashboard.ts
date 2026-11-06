import { can, Permission } from '../../api/permissions'
import type { AccountPlayer } from '../../api/queries'
import type { components } from '../../api/schema'

type Session = components['schemas']['SessionAccount']

export type RecentMatch = AccountPlayer['recent_matches'][number]
export type Outcome = 'won' | 'lost'

// One of the account's players as every dashboard option shows it. `form`
// holds the outcomes of its recent matches that have a result, newest
// first, and `record` and `streak` count them.
export type PlayerSummary = {
  player: AccountPlayer
  form: readonly Outcome[]
  record: { won: number; lost: number }
  streak: { outcome: Outcome; length: number } | null
  last: RecentMatch | null
}

// Something the account should do, most pressing first. Each option shows
// the first one as its lead and may list the rest.
export type Attention =
  | { kind: 'review-players'; count: number }
  | { kind: 'keep-guest-matches'; matchCount: number }
  | { kind: 'first-match' }

export type Dashboard = {
  me: PlayerSummary
  managed: readonly PlayerSummary[]
  attention: readonly Attention[]
  guest: boolean
  canCreateMatch: boolean
}

export function summarize(player: AccountPlayer): PlayerSummary {
  const form = player.recent_matches.flatMap((match): Outcome[] =>
    match.result ? [match.result.won ? 'won' : 'lost'] : [],
  )
  const won = form.filter((outcome) => outcome === 'won').length
  const first = form.at(0)
  let length = 0
  while (form[length] !== undefined && form[length] === first) length++
  return {
    player,
    form,
    record: { won, lost: form.length - won },
    streak: first ? { outcome: first, length } : null,
    last: player.recent_matches.at(0) ?? null,
  }
}

// Which attention items apply, in the order they show.
const ATTENTION: readonly ((input: { account: Session; players: readonly AccountPlayer[] }) => Attention | null)[] = [
  ({ players }) => {
    const count = players.filter((player) => player.open_question).length
    return count > 0 ? { kind: 'review-players', count } : null
  },
  ({ account, players }) => {
    const matchCount = players.reduce((sum, player) => sum + player.match_count, 0)
    return account.kind === 'guest' && matchCount > 0 ? { kind: 'keep-guest-matches', matchCount } : null
  },
  ({ account, players }) =>
    can(account, Permission.matchesCreate) && players.every((player) => player.match_count === 0)
      ? { kind: 'first-match' }
      : null,
]

export function dashboard(account: Session, players: readonly AccountPlayer[]): Dashboard {
  const self = players.find((player) => player.relationship === 'self') ?? {
    id: account.player.id,
    display_name: account.player.display_name,
    relationship: 'self' as const,
    open_question: false,
    match_count: 0,
    recent_matches: [],
    played_against: [],
  }
  return {
    me: summarize(self),
    managed: players.filter((player) => player !== self).map(summarize),
    attention: ATTENTION.map((rule) => rule({ account, players })).filter((item) => item !== null),
    guest: account.kind === 'guest',
    canCreateMatch: can(account, Permission.matchesCreate),
  }
}

export function opponentsOf(match: RecentMatch): string {
  return match.opponents.length > 0 ? match.opponents.join(' & ') : 'Another player'
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString()
}

// "Today", "Yesterday", or the date, for grouping and for a match's line.
export function dayLabel(playedAt: string, now: Date): string {
  const at = new Date(playedAt)
  if (sameDay(at, now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(at, yesterday)) return 'Yesterday'
  return at.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

// The day inside a sentence: "today", "yesterday" or "on Wed, 4 Nov".
export function dayInSentence(playedAt: string, now: Date): string {
  const day = dayLabel(playedAt, now)
  return day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : `on ${day}`
}

export function timeLabel(playedAt: string): string {
  return new Date(playedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function streakText(summary: PlayerSummary): string | null {
  const { streak } = summary
  if (!streak || streak.length < 2) return null
  return `${streak.outcome === 'won' ? 'Won' : 'Lost'} ${streak.length} in a row`
}

export function recordText(summary: PlayerSummary): string {
  const { won, lost } = summary.record
  return `${won}–${lost}`
}

export function matchCountText(count: number): string {
  return count === 1 ? '1 match' : `${count} matches`
}
