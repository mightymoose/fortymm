// The reviewed player's recent matches under "Is this you?", so a person
// can tell their own player by who they played. Styled by `.review-preview*`
// in adoption.css.

export type PreviewResult = { won: boolean; games: readonly [number, number] }

export type PreviewMatch = {
  id: string
  played_at: string
  opponent: string
  // The games each side won, the reviewed player's first. Null until the
  // match has a result.
  result: PreviewResult | null
}

export type PreviewVariant = 'list' | 'rows' | 'last'

export function MatchPreview({
  player,
  count,
  recent,
  variant,
  now,
}: {
  player: string
  count: number
  recent: readonly PreviewMatch[]
  variant: PreviewVariant
  now: Date
}) {
  const shown = variant === 'last' ? recent.slice(0, 1) : recent
  const more = count - shown.length
  return (
    <section className="review-preview" aria-label="Recent matches">
      <p className="review-preview__head">{headline(count, recent, now)}</p>
      {shown.length > 0 && variant === 'rows' && (
        <div className="fm-matches review-preview__rows">
          {shown.map((match) => (
            <KitRow key={match.id} player={player} match={match} now={now} />
          ))}
        </div>
      )}
      {shown.length > 0 && variant !== 'rows' && (
        <ul className={`review-preview__list review-preview__list--${variant}`}>
          {shown.map((match) => (
            <ListRow key={match.id} match={match} now={now} />
          ))}
        </ul>
      )}
      {more > 0 && recent.length > 0 && (
        <p className="review-preview__more">
          {more === 1 ? '1 earlier match' : `${more} earlier matches`}
        </p>
      )}
    </section>
  )
}

function ListRow({ match, now }: { match: PreviewMatch; now: Date }) {
  return (
    <li className="review-preview__match">
      <span className="review-preview__opp">{match.opponent}</span>
      <Outcome result={match.result} />
      <span className="review-preview__when">{when(match.played_at, now)}</span>
    </li>
  )
}

function Outcome({ result }: { result: PreviewResult | null }) {
  if (!result) return <span className="review-preview__result review-preview__result--none">No result</span>
  return (
    <span className={`review-preview__result review-preview__result--${result.won ? 'won' : 'lost'}`}>
      {result.won ? 'Won' : 'Lost'} <span className="num">{result.games[0]}–{result.games[1]}</span>
    </span>
  )
}

// The kit's final match row: both names, the winner bold, games won boxed.
function KitRow({ player, match, now }: { player: string; match: PreviewMatch; now: Date }) {
  const { result } = match
  const sides = [
    { name: player, games: result?.games[0], won: result?.won },
    { name: match.opponent, games: result?.games[1], won: result && !result.won },
  ]
  return (
    <article
      className="fm-match"
      data-state={result ? 'final' : 'upcoming'}
      aria-label={`${player} vs ${match.opponent}`}
    >
      <div className="fm-match__head">
        <span className="fm-status">{result ? 'Final' : 'No result'}</span>
        <span>{when(match.played_at, now)}</span>
      </div>
      {sides.map((side) => (
        <div
          key={side.name}
          className={`fm-match__p${side.won === undefined || side.won === null ? '' : side.won ? ' w' : ' l'}`}
        >
          <span className="fm-match__name">{side.name}</span>
          {result && (
            <>
              <span />
              <span className="fm-match__games">{side.games}</span>
            </>
          )}
        </div>
      ))}
    </article>
  )
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString()
}

function dayOf(at: Date, now: Date): 'today' | 'yesterday' | string {
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
export function headline(count: number, recent: readonly PreviewMatch[], now: Date): string {
  const last = recent.at(0)
  if (count === 0 || !last) return 'No matches yet'
  const matches = count === 1 ? '1 match' : `${count} matches`
  const allToday = count === recent.length && recent.every((match) => sameDay(new Date(match.played_at), now))
  if (allToday) {
    return count === 1 ? `1 match today, against ${last.opponent}` : `${matches} today, last one against ${last.opponent}`
  }
  const day = dayOf(new Date(last.played_at), now)
  const on = day === 'today' || day === 'yesterday' ? day : `on ${day}`
  return count === 1 ? `1 match ${on}, against ${last.opponent}` : `${matches}, last one ${on} against ${last.opponent}`
}
