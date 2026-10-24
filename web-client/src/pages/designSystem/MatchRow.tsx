import { useId, useState } from 'react'
import { Icon } from '../../components/Icon'
import { GameScores } from './GameScores'
import { isScored, matchScore, type Match, type Side } from './match'
import { MatchStatus } from './MatchStatus'

// The line under the status: table, round, and the game in play or when an
// offline scorer last reported.
function meta(match: Match, gameInPlay: number | null) {
  return (
    <>
      Table {match.table} · {match.round}
      {match.state === 'live' && gameInPlay !== null && ` · Game ${gameInPlay}`}
      {match.state === 'offline' && (
        <>
          {' · last update '}
          <span className="num">{match.offlineSince}</span>
        </>
      )}
    </>
  )
}

// A match row as match.js's `row()` draws it: status, names, games won
// (boxed) and current points (large), styled by `.fm-match` in
// styles/kit.css. `large` is `.fm-match--lg`. `headHidden` keeps the status
// line out of view where a heading above already says it, as in a sheet.
// `gameScores` adds a "Game scores" toggle under a match with games, which
// shows and hides its GameScores.
export function MatchRow({
  match,
  large = false,
  headHidden = false,
  columns = true,
  clubs = false,
  gameScores = false,
}: {
  match: Match
  large?: boolean
  headHidden?: boolean
  columns?: boolean
  clubs?: boolean
  gameScores?: boolean
}) {
  const scoresId = useId()
  const [scoresShown, setScoresShown] = useState(false)
  const { done, current, won, winner } = matchScore(match)
  const scored = isScored(match)
  const [first, second] = match.players

  return (
    <article
      className={large ? 'fm-match fm-match--lg' : 'fm-match'}
      data-state={match.state}
      aria-label={`${first.name} vs ${second.name}`}
    >
      <div className="fm-match__head" hidden={headHidden}>
        <MatchStatus match={match} />
        <span>{meta(match, current ? done.length + 1 : null)}</span>
      </div>
      {columns && (scored || match.state === 'final') && (
        <div className="fm-match__p fm-match__cols" aria-hidden="true">
          <span></span>
          <span></span>
          <span>Games</span>
          {scored && <span>Points</span>}
        </div>
      )}
      {([0, 1] as const).map((side: Side) => {
        const player = match.players[side]
        const result = winner === null ? '' : winner === side ? ' w' : ' l'
        const points = current ? current[side] : 0
        return (
          <div key={side} className={`fm-match__p${result}`}>
            <span className="fm-match__name">
              {player.name}
              {clubs && player.club && <small>{player.club}</small>}
            </span>
            {(scored || match.state === 'final') && (
              <>
                <span>
                  {scored && match.serve === side && (
                    <span className="serve-marker" role="img" aria-label="Serving"></span>
                  )}
                </span>
                <span className="fm-match__games" aria-label={`${won[side]} games won`}>
                  {won[side]}
                </span>
                {scored && (
                  <span
                    className="fm-match__pts"
                    aria-label={`${points} points in this game`}
                  >
                    {points}
                  </span>
                )}
              </>
            )}
          </div>
        )
      })}
      {match.state === 'upcoming' && match.rest && (
        <p className="fm-notice fm-notice--rest">
          <Icon name="clock" />
          <span>
            {match.rest.who} rests until <span className="num">{match.rest.until}</span>
          </span>
        </p>
      )}
      {gameScores && match.games.length > 0 && (
        <>
          <button
            type="button"
            className="fm-match__toggle"
            aria-expanded={scoresShown}
            aria-controls={scoresId}
            onClick={() => setScoresShown(!scoresShown)}
          >
            Game scores
            <Icon name="chevron" />
          </button>
          <div id={scoresId} hidden={!scoresShown}>
            <GameScores match={match} />
          </div>
        </>
      )}
    </article>
  )
}
