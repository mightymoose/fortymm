import { useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { EmptyState } from '../../../components/EmptyState'
import { Icon } from '../../../components/Icon'
import { QueryBoundary } from '../../../components/QueryBoundary'
import { matchQuery } from './matchQueries'
import { MatchStatus, RatingChange } from './MatchStatus'
import {
  formatDay,
  formatLabel,
  formatTime,
  score,
  vsLabel,
  yourSide,
  type GameScore,
  type MatchRecord,
  type Side,
} from './sampleMatches'

// A match's page, in its own boundary: the games, each player's signature,
// and what the viewer can do about the result.
export function MatchSignOff({ id }: { id: string }) {
  return (
    <QueryBoundary skeleton={<SignOffSkeleton />}>
      <LoadedSignOff id={id} />
    </QueryBoundary>
  )
}

function SignOffSkeleton() {
  return (
    <div className="match-page" aria-busy="true">
      <span className="fm-sr" role="status">
        Loading match
      </span>
      <div className="match-page__head" aria-hidden="true">
        <div className="fm-skeleton match-skel match-skel--status" />
        <div className="fm-skeleton match-skel match-skel--title" />
        <div className="fm-skeleton match-skel match-skel--line" />
      </div>
      <div className="match-columns" aria-hidden="true">
        <div className="match-section">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="fm-skeleton match-skel match-skel--game" />
          ))}
        </div>
        <div className="fm-skeleton match-skel match-skel--card" />
      </div>
    </div>
  )
}

function LoadedSignOff({ id }: { id: string }) {
  const { data: match } = useSuspenseQuery(matchQuery(id))
  if (!match)
    return (
      <>
        <h1>No such match</h1>
        <EmptyState title="This match isn’t here">The link may be wrong. Find the match on the Matches page.</EmptyState>
      </>
    )
  return <DetailSignOff match={match} />
}

type Action = { label: string; kind: 'primary' | 'secondary' | 'ghost' }
type Situation = {
  // A sentence in the content flow, or an alert for a problem with its fix.
  notice: { icon: 'info' | 'clock' | 'check'; text: string } | null
  alert: { title: string; body: string } | null
  actions: readonly Action[]
}

const other = (side: Side): Side => (side === 0 ? 1 : 0)

const gamesText = (games: readonly GameScore[], first: Side) =>
  games.map((game) => `${game[first]}–${game[other(first)]}`).join(', ')

function wonOf(games: readonly GameScore[], side: Side) {
  return games.filter((game) => game[side] > game[side === 0 ? 1 : 0]).length
}

// What the match asks of the viewer now: a player of the match is asked to
// sign, anyone else is told where it stands.
function situation(match: MatchRecord): Situation {
  const { status } = match
  const mine = yourSide(match)
  const name = (side: Side) => match.players[side].name
  switch (status.kind) {
    case 'live':
      return {
        notice: { icon: 'info', text: 'Anyone can keep score. Only the players sign the result.' },
        alert: null,
        actions: [{ label: 'Keep score', kind: 'primary' }, { label: 'Share match', kind: 'ghost' }],
      }
    case 'awaiting': {
      const signer = name(status.signedBy)
      const waiting = other(status.signedBy)
      const at = formatTime(status.signedAt)
      if (mine === waiting) {
        const { won } = score(match)
        return {
          notice: { icon: 'clock', text: `${signer} signed these scores at ${at}. Approve them if they’re right.` },
          alert: null,
          actions: [
            { label: `Approve ${won[mine]}–${won[other(mine)]}`, kind: 'primary' },
            { label: 'Enter different scores', kind: 'secondary' },
          ],
        }
      }
      if (mine === status.signedBy)
        return {
          notice: { icon: 'clock', text: `You signed at ${at}. The result counts once ${name(waiting)} approves it.` },
          alert: null,
          actions: [{ label: 'Show QR code', kind: 'secondary' }, { label: 'Share result', kind: 'ghost' }],
        }
      return {
        notice: { icon: 'clock', text: `${signer} signed at ${at}. The result counts once ${name(waiting)} approves it.` },
        alert: null,
        actions: [{ label: 'Share match', kind: 'ghost' }],
      }
    }
    case 'disputed': {
      const versions: Record<Side, readonly GameScore[]> =
        status.signedBy === 0 ? { 0: match.games, 1: status.theirGames } : { 0: status.theirGames, 1: match.games }
      const version = (side: Side) => {
        const games = versions[side]
        const who = side === mine ? 'You' : name(side)
        return `${who} signed ${wonOf(games, 0)}–${wonOf(games, 1)} (${gamesText(games, 0)})`
      }
      if (mine === null)
        return {
          notice: null,
          alert: {
            title: 'The players signed different scores',
            body: `${version(0)}. ${version(1)}. It counts once they both sign the same scores.`,
          },
          actions: [{ label: 'Share match', kind: 'ghost' }],
        }
      const them = name(other(mine))
      return {
        notice: null,
        alert: {
          title: `${them} signed different scores`,
          body: `${version(mine)}. ${version(other(mine))}. It counts once you both sign the same scores.`,
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

// A button for an action the app can't do yet. Pressing it says so.
function DemoButton({ action }: { action: Action }) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      type="button"
      className={`fm-btn fm-btn--${action.kind}`}
      onClick={() => setPressed(true)}
    >
      {pressed ? 'Not ready yet' : action.label}
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

// Each game reads as a line on the left; the right shows each player's
// signature and what's left before the result counts.
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
