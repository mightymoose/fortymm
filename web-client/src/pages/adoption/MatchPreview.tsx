import { useState } from 'react'
import type { AccountPlayer } from '../../api/queries'

// The reviewed player's recent matches under "Is this you?", so a person
// can tell their own player by who they played.

type RecentMatch = AccountPlayer['recent_matches'][number]

export function MatchPreview({ player }: { player: AccountPlayer }) {
  // Fixed at mount, so "today" doesn't change under the reader.
  const [now] = useState(() => new Date())
  const recent = player.recent_matches
  const more = player.match_count - recent.length
  return (
    <section className="review-preview" aria-label="Recent matches">
      <p className="review-preview__head">{headline(player.match_count, recent, now)}</p>
      {recent.length > 0 && (
        <ul className="review-preview__list">
          {recent.map((match) => (
            <li key={match.id} className="review-preview__match">
              <span className="review-preview__opp">{opponents(match) ?? 'Another player'}</span>
              <Outcome result={match.result} />
              <span className="review-preview__when">{when(match.played_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && recent.length > 0 && (
        <p className="review-preview__more">{more === 1 ? '1 earlier match' : `${more} earlier matches`}</p>
      )}
    </section>
  )
}

function Outcome({ result }: { result: RecentMatch['result'] }) {
  if (!result) return <span className="review-preview__result review-preview__result--none">No result</span>
  return (
    <span className={`review-preview__result review-preview__result--${result.won ? 'won' : 'lost'}`}>
      {result.won ? 'Won' : 'Lost'}{' '}
      <span className="num">
        {result.games[0]}–{result.games[1]}
      </span>
    </span>
  )
}

function opponents(match: RecentMatch): string | undefined {
  return match.opponents.length > 0 ? match.opponents.join(' & ') : undefined
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString()
}

function dayOf(at: Date, now: Date): string {
  if (sameDay(at, now)) return 'today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(at, yesterday)) return 'yesterday'
  return at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function when(playedAt: string, now: Date): string {
  const at = new Date(playedAt)
  const day = dayOf(at, now)
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${time}`
}

// "3 matches today, last one against Sam", or the count and the day of the
// last one when not every match was today.
function headline(count: number, recent: readonly RecentMatch[], now: Date): string {
  const last = recent.at(0)
  if (count === 0 || !last) return 'No matches yet'
  const against = opponents(last) ?? 'another player'
  const matches = count === 1 ? '1 match' : `${count} matches`
  const allToday = count === recent.length && recent.every((match) => sameDay(new Date(match.played_at), now))
  if (allToday) {
    return count === 1 ? `1 match today, against ${against}` : `${matches} today, last one against ${against}`
  }
  const day = dayOf(new Date(last.played_at), now)
  const on = day === 'today' || day === 'yesterday' ? day : `on ${day}`
  return count === 1 ? `1 match ${on}, against ${against}` : `${matches}, last one ${on} against ${against}`
}
