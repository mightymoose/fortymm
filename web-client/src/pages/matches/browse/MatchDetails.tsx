import { useId, useState } from 'react'
import { Icon } from '../../../components/Icon'
import {
  formatDay,
  formatLabel,
  formatTime,
  needsYou,
  opponent,
  score,
  yourSide,
  type GameScore,
  type MatchRecord,
  type Side,
} from './sampleMatches'
import { MatchStatus, RatingChange } from './parts'
import { vsLabel, type Variant } from './variants'
import { ScoreRow } from './MatchLists'

export function MatchDetails({ match, variant }: { match: MatchRecord; variant: Variant }) {
  if (variant === 'b') return <DetailCard match={match} />
  if (variant === 'c') return <DetailSignOff match={match} />
  return <DetailScoreboard match={match} />
}

type Action = { label: string; kind: 'primary' | 'secondary' | 'ghost' }
type Situation = {
  // A sentence in the content flow, or an alert for a problem with its fix.
  notice: { icon: 'info' | 'clock' | 'check'; text: string } | null
  alert: { title: string; body: string } | null
  actions: readonly Action[]
}

const gamesText = (games: readonly GameScore[], mine: Side) =>
  games.map((game) => `${game[mine]}–${game[mine === 0 ? 1 : 0]}`).join(', ')

function wonOf(games: readonly GameScore[], side: Side) {
  return games.filter((game) => game[side] > game[side === 0 ? 1 : 0]).length
}

// What the match asks of the viewer now, from its state and their side.
function situation(match: MatchRecord): Situation {
  const { status } = match
  const mine = yourSide(match) ?? 0
  const them = opponent(match).name
  switch (status.kind) {
    case 'live':
      return {
        notice: { icon: 'info', text: 'Anyone can keep score. Only the players sign the result.' },
        alert: null,
        actions: [{ label: 'Keep score', kind: 'primary' }, { label: 'Share match', kind: 'ghost' }],
      }
    case 'awaiting':
      if (needsYou(match)) {
        const { won } = score(match)
        return {
          notice: { icon: 'clock', text: `${them} signed these scores at ${formatTime(status.signedAt)}. Approve them if they’re right.` },
          alert: null,
          actions: [
            { label: `Approve ${won[mine]}–${won[mine === 0 ? 1 : 0]}`, kind: 'primary' },
            { label: 'Enter different scores', kind: 'secondary' },
          ],
        }
      }
      return {
        notice: { icon: 'clock', text: `You signed at ${formatTime(status.signedAt)}. The result counts once ${them} approves it.` },
        alert: null,
        actions: [{ label: 'Show QR code', kind: 'secondary' }, { label: 'Share result', kind: 'ghost' }],
      }
    case 'disputed': {
      const yours = status.signedBy === mine ? match.games : status.theirGames
      const theirs = status.signedBy === mine ? status.theirGames : match.games
      const other: Side = mine === 0 ? 1 : 0
      return {
        notice: null,
        alert: {
          title: `${them} signed different scores`,
          body: `You signed ${wonOf(yours, mine)}–${wonOf(yours, other)} (${gamesText(yours, mine)}). ${them} signed ${wonOf(theirs, mine)}–${wonOf(theirs, other)} (${gamesText(theirs, mine)}). It counts once you both sign the same scores.`,
        },
        actions: [
          { label: `Approve ${them}’s scores`, kind: 'primary' },
          { label: 'Correct and sign again', kind: 'secondary' },
        ],
      }
    }
    case 'final':
      return {
        notice: { icon: 'check', text: `Both players approved this result on ${formatDay(status.approvedAt)}.` },
        alert: null,
        actions: [{ label: 'Share result', kind: 'secondary' }],
      }
  }
}

// A button for an action the prototype can't do. Pressing it says so.
function DemoButton({ action }: { action: Action }) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      type="button"
      className={`fm-btn fm-btn--${action.kind}`}
      onClick={() => setPressed(true)}
    >
      {pressed ? 'Not in the prototype' : action.label}
    </button>
  )
}

function Actions({ actions, className }: { actions: readonly Action[]; className?: string }) {
  return (
    <div className={className ?? 'match-actions'}>
      {actions.map((action) => (
        <DemoButton key={action.label} action={action} />
      ))}
    </div>
  )
}

function SituationNotes({ s }: { s: Situation }) {
  return (
    <>
      {s.alert && (
        <div className="fm-alert fm-alert--warning" role="group" aria-label="Scores disagree">
          <Icon name="alert" />
          <p className="fm-alert__title">{s.alert.title}</p>
          <p className="fm-alert__body">{s.alert.body}</p>
        </div>
      )}
      {s.notice && (
        <p className={s.notice.icon === 'check' ? 'fm-notice fm-notice--success' : 'fm-notice'}>
          <Icon name={s.notice.icon} />
          <span>{s.notice.text}</span>
        </p>
      )}
    </>
  )
}

// The game history as the design system's `.fm-games` draws it, in side
// order, the game in play marked "now".
function GameTable({ match }: { match: MatchRecord }) {
  const live = match.status.kind === 'live'
  if (!match.games.length) return <p className="fm-help">No games played yet.</p>
  const isCurrent = (index: number) => live && index === match.games.length - 1
  return (
    <div className="fm-scroll">
      <table className="fm-games">
        <caption className="fm-sr">Game scores, {vsLabel(match)}</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="fm-sr">Player</span>
            </th>
            {match.games.map((_, index) => (
              <th key={index} scope="col" className={isCurrent(index) ? 'cur' : undefined}>
                {isCurrent(index) ? `Game ${index + 1} · now` : `Game ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {([0, 1] as const).map((side) => (
            <tr key={side}>
              <th scope="row">{match.players[side].name}</th>
              {match.games.map((game, index) => (
                <td key={index} className={isCurrent(index) ? 'cur' : game[side] > game[side === 0 ? 1 : 0] ? 'w' : undefined}>
                  {game[side]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Facts({ match }: { match: MatchRecord }) {
  return (
    <dl className="fm-dl">
      <div>
        <dt>Format</dt>
        <dd>{formatLabel(match)}</dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd>
          {formatDay(match.startedAt)}, <span className="num">{formatTime(match.startedAt)}</span>
        </dd>
      </div>
      {match.status.kind === 'final' && match.status.rating && (
        <div>
          <dt>Your rating</dt>
          <dd>
            <RatingChange match={match} />
          </dd>
        </div>
      )}
    </dl>
  )
}

function History({ match }: { match: MatchRecord }) {
  return (
    <ol className="fm-list fm-list--divided">
      {match.history.map((event) => (
        <li key={event.at + event.what} className="match-event">
          <span className="num match-muted">{formatTime(event.at)}</span>
          <span>
            <b>{event.who}</b> {event.what.charAt(0).toLowerCase() + event.what.slice(1)}
          </span>
        </li>
      ))}
    </ol>
  )
}

// A: a scoreboard page. The large match row leads, then what to do, the
// game scores, the facts and the history, each a section of its own.
function DetailScoreboard({ match }: { match: MatchRecord }) {
  const s = situation(match)
  return (
    <div className="match-page">
      <div className="match-page__head">
        <MatchStatus match={match} />
        <h1 className="match-title">{vsLabel(match)}</h1>
      </div>
      <ScoreRow match={match} large headHidden />
      <SituationNotes s={s} />
      <Actions actions={s.actions} />
      <section className="match-section">
        <h2 className="fm-section-title">Game scores</h2>
        <GameTable match={match} />
      </section>
      <section className="match-section">
        <h2 className="fm-section-title">Details</h2>
        <Facts match={match} />
      </section>
      <section className="match-section">
        <h2 className="fm-section-title">History</h2>
        <History match={match} />
      </section>
    </div>
  )
}

// B: one card, as the design system's match detail draws it: title and
// status, the row, the problem or notice, game scores and facts, actions at
// the foot. The history folds away.
function DetailCard({ match }: { match: MatchRecord }) {
  const s = situation(match)
  const titleId = useId()
  const historyId = useId()
  const [historyShown, setHistoryShown] = useState(false)
  return (
    <div className="match-page match-page--narrow">
      <h1 className="fm-sr">{vsLabel(match)}</h1>
      <section className="fm-card" aria-labelledby={titleId}>
        <div className="fm-card__head">
          <div>
            <h2 className="fm-card__title" id={titleId}>
              vs {opponent(match).name}
            </h2>
            <p className="fm-card__sub">
              {formatDay(match.startedAt)} · {formatLabel(match)}
            </p>
          </div>
          <MatchStatus match={match} />
        </div>
        <div className="fm-card__body">
          <ScoreRow match={match} large headHidden />
          <SituationNotes s={s} />
          <div>
            <h3 className="fm-section-title match-subhead">Game scores</h3>
            <GameTable match={match} />
          </div>
          <Facts match={match} />
          <button
            type="button"
            className="fm-match__toggle"
            aria-expanded={historyShown}
            aria-controls={historyId}
            onClick={() => setHistoryShown(!historyShown)}
          >
            History
            <Icon name="chevron" />
          </button>
          <div id={historyId} hidden={!historyShown}>
            <History match={match} />
          </div>
        </div>
        <Actions actions={s.actions} className="fm-card__foot" />
      </section>
    </div>
  )
}

// C: the sign-off. Each game reads as a sentence on the left; the right
// shows each player's signature and what's left before the result counts.
function DetailSignOff({ match }: { match: MatchRecord }) {
  const s = situation(match)
  const { won, winner } = score(match)
  const live = match.status.kind === 'live'
  return (
    <div className="match-page">
      <div className="match-page__head">
        <MatchStatus match={match} />
        <h1 className="match-title">{vsLabel(match)}</h1>
        <p className="match-muted">
          {formatDay(match.startedAt)} · {formatLabel(match)}
        </p>
      </div>
      <div className="match-columns">
        <section className="match-section" aria-label="Games">
          <p className="match-tally">
            <span className={winner === 0 ? 'match-strong' : undefined}>{match.players[0].name}</span>
            <span className="num match-tally__score">
              {won[0]}–{won[1]}
            </span>
            <span className={winner === 1 ? 'match-strong' : undefined}>{match.players[1].name}</span>
          </p>
          <ol className="fm-list fm-list--divided">
            {match.games.map((game, index) => {
              const inPlay = live && index === match.games.length - 1
              const gameWinner: Side = game[0] > game[1] ? 0 : 1
              return (
                <li key={index} className="match-game">
                  <span className="match-game__n">Game {index + 1}</span>
                  <span className="num match-game__score">
                    <span className={!inPlay && gameWinner === 0 ? 'match-strong' : undefined}>{game[0]}</span>–
                    <span className={!inPlay && gameWinner === 1 ? 'match-strong' : undefined}>{game[1]}</span>
                  </span>
                  <span className="match-muted">
                    {inPlay ? <span className="live-marker">Live</span> : `${match.players[gameWinner].name} won`}
                  </span>
                </li>
              )
            })}
          </ol>
        </section>
        <aside className="fm-card" aria-label="Sign-off">
          <div className="fm-card__head">
            <h2 className="fm-card__title">Sign-off</h2>
          </div>
          <div className="fm-card__body">
            <ul className="fm-list">
              {([0, 1] as const).map((side) => (
                <li key={side} className="match-signer">
                  <SignatureState match={match} side={side} />
                </li>
              ))}
            </ul>
            <SituationNotes s={s} />
          </div>
          <Actions actions={s.actions} className="fm-card__foot" />
        </aside>
      </div>
      <section className="match-section">
        <h2 className="fm-section-title">History</h2>
        <History match={match} />
      </section>
    </div>
  )
}

function SignatureState({ match, side }: { match: MatchRecord; side: Side }) {
  const { status } = match
  const player = match.players[side]
  const name = player.you ? `${player.name} (you)` : player.name
  let state: { icon: 'check' | 'clock' | 'alert'; text: string }
  if (status.kind === 'final') state = { icon: 'check', text: `Approved` }
  else if (status.kind === 'live') state = { icon: 'clock', text: 'Signs when the match ends' }
  else if (status.kind === 'awaiting')
    state = status.signedBy === side ? { icon: 'check', text: `Signed at ${formatTime(status.signedAt)}` } : { icon: 'clock', text: 'Not signed yet' }
  else state = { icon: 'alert', text: status.signedBy === side ? 'Signed one set of scores' : 'Signed different scores' }
  return (
    <>
      <span className={`match-signer__icon match-signer__icon--${state.icon}`}>
        <Icon name={state.icon} />
      </span>
      <span>
        <b className="match-signer__name">{name}</b>
        <span className="match-muted match-block">{state.text}</span>
      </span>
      {status.kind === 'final' && <RatingChange match={match} side={side} />}
    </>
  )
}
