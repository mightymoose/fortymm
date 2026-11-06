import { MatchStatus } from './MatchStatus'
import {
  formatDay,
  formatLabel,
  formatTime,
  score,
  vsLabel,
  type MatchRecord,
  type MatchStatus as Status,
  type Side,
} from './match'

const ROW_STATE = {
  new: 'upcoming',
  live: 'live',
  awaiting: 'final',
  disputed: 'final',
  final: 'final',
} as const satisfies Record<Status['kind'], 'upcoming' | 'live' | 'final'>

// One `.fm-match` row: status, when and the format, then each player with
// games won (boxed) and, while live, the points in the game in play. A match
// nobody has scored shows only the names.
export function ScoreRow({ match }: { match: MatchRecord }) {
  const { current, won, winner } = score(match)
  const state = ROW_STATE[match.status.kind]
  return (
    <article className="fm-match" data-state={state} aria-label={vsLabel(match)}>
      <div className="fm-match__head">
        <MatchStatus match={match} />
        <span>
          {formatDay(match.startedAt)} <span className="num">{formatTime(match.startedAt)}</span> ·{' '}
          {formatLabel(match)}
        </span>
      </div>
      {state !== 'upcoming' && (
        <div className="fm-match__p fm-match__cols" aria-hidden="true">
          <span></span>
          <span></span>
          <span>Games</span>
          {state === 'live' && <span>Points</span>}
        </div>
      )}
      {([0, 1] as const).map((side: Side) => {
        const player = match.players[side]
        const result = winner === null ? '' : winner === side ? ' w' : ' l'
        return (
          <div key={side} className={`fm-match__p${result}`}>
            <span className="fm-match__name">
              {player.name}
              {player.you && <small>You</small>}
            </span>
            {state !== 'upcoming' && (
              <>
                <span></span>
                <span className="fm-match__games" aria-label={`${won[side]} games won`}>
                  {won[side]}
                </span>
              </>
            )}
            {state === 'live' && (
              <span className="fm-match__pts" aria-label={`${current?.[side] ?? 0} points in this game`}>
                {current?.[side] ?? 0}
              </span>
            )}
          </div>
        )
      })}
    </article>
  )
}
