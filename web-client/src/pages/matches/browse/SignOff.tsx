import { useSuspenseQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { matchQuery } from '../../../api/queries'
import { EmptyState } from '../../../components/EmptyState'
import { Icon } from '../../../components/Icon'
import { QueryBoundary } from '../../../components/QueryBoundary'
import {
  eventText,
  finished,
  formatDay,
  formatLabel,
  formatTime,
  lastGameInPlay,
  other,
  score,
  vsLabel,
  wonOf,
  yourSide,
  type GameScore,
  type MatchDetail,
  type MatchRecord,
  type Side,
} from './match'
import { MatchStatus } from './MatchStatus'

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
  const { api } = useRouteContext({ from: '__root__' })
  const { data: match, dataUpdatedAt } = useSuspenseQuery(matchQuery(api, id))
  if (!match)
    return (
      <>
        <h1>No such match</h1>
        <EmptyState title="This match isn’t here">The link may be wrong. Find the match on the Matches page.</EmptyState>
      </>
    )
  return <DetailSignOff match={match} updatedAt={dataUpdatedAt} />
}

type Action = { label: string; kind: 'primary' | 'secondary' | 'ghost' }
type Situation = {
  // A sentence in the content flow, or an alert for a problem with its fix.
  notice: { icon: 'info' | 'clock' | 'check'; text: string } | null
  alert: { title: string; body: string } | null
  actions: readonly Action[]
}

const gamesText = (games: readonly GameScore[], first: Side) =>
  games.map((game) => `${game[first]}–${game[other(first)]}`).join(', ')

// What the match asks of the viewer now: a player of the match is asked to
// sign, anyone else is told where it stands.
function situation(match: MatchRecord): Situation {
  const { status } = match
  const mine = yourSide(match)
  const name = (side: Side) => match.players[side].name
  switch (status.kind) {
    case 'new':
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
    case 'final': {
      const day = formatDay(status.acceptedAt)
      let text = `Both players approved this result on ${day}.`
      if (status.overrideReason !== null)
        text = `An administrator set this result on ${day}. They wrote: “${status.overrideReason}”`
      else if (status.approvedBy.length === 1) text = `${name(status.approvedBy[0])} reported this result on ${day}.`
      return {
        notice: { icon: 'check', text },
        alert: null,
        actions: [{ label: 'Share result', kind: 'secondary' }],
      }
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

function History({ match }: { match: MatchDetail }) {
  return (
    <ol className="fm-list fm-list--divided">
      {match.history.map((event, index) => {
        const text = eventText(match.history, index)
        return (
          <li key={index} className="match-event">
            <span className="num match-muted">{formatTime(event.at)}</span>
            <span>
              <b>{event.by ?? 'Someone'}</b> {text.charAt(0).toLowerCase() + text.slice(1)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// Each game reads as a line on the left; the right shows each player's
// signature and what's left before the result counts.
function DetailSignOff({ match, updatedAt }: { match: MatchDetail; updatedAt: number }) {
  const s = situation(match)
  const { won, winner } = score(match)
  const lastInPlay = lastGameInPlay(match)
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
          {match.status.kind !== 'final' && (
            <p className="match-muted">Updated {formatTime(new Date(updatedAt).toISOString())}</p>
          )}
          {match.games.length ? (
            <ol className="fm-list fm-list--divided">
              {match.games.map((game, index) => {
                const inPlay = lastInPlay && index === match.games.length - 1
                const gameWinner: Side | null = !inPlay && finished(game) ? (game[0] > game[1] ? 0 : 1) : null
                return (
                  <li key={index} className="match-game">
                    <span className="match-game__n">Game {index + 1}</span>
                    <span className="num match-game__score">
                      <span className={gameWinner === 0 ? 'match-strong' : undefined}>{game[0]}</span>–
                      <span className={gameWinner === 1 ? 'match-strong' : undefined}>{game[1]}</span>
                    </span>
                    <span className="match-muted">
                      {inPlay ? (
                        <span className="live-marker">Live</span>
                      ) : gameWinner === null ? (
                        'Not finished'
                      ) : (
                        `${match.players[gameWinner].name} won`
                      )}
                    </span>
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="match-muted">No scores yet.</p>
          )}
          {match.retiredBy !== null && <p className="match-muted">{match.players[match.retiredBy].name} retired.</p>}
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
      <section className="match-section" aria-label="History">
        <h2 className="fm-section-title">History</h2>
        <History match={match} />
      </section>
    </div>
  )
}

function signature(match: MatchRecord, side: Side): { icon: 'check' | 'clock' | 'alert'; text: string } {
  const { status } = match
  switch (status.kind) {
    case 'new':
    case 'live':
      return { icon: 'clock', text: 'Signs when the match ends' }
    case 'awaiting':
      return status.signedBy === side
        ? { icon: 'check', text: `Signed at ${formatTime(status.signedAt)}` }
        : { icon: 'clock', text: 'Not signed yet' }
    case 'disputed':
      return { icon: 'alert', text: status.signedBy === side ? 'Signed one set of scores' : 'Signed different scores' }
    case 'final':
      if (status.overrideReason !== null) return { icon: 'check', text: 'Set by an administrator' }
      return status.approvedBy.includes(side)
        ? { icon: 'check', text: 'Approved' }
        : { icon: 'clock', text: 'Hasn’t approved' }
  }
}

function SignatureState({ match, side }: { match: MatchRecord; side: Side }) {
  const player = match.players[side]
  const state = signature(match, side)
  return (
    <>
      <span className={`match-signer__icon match-signer__icon--${state.icon}`}>
        <Icon name={state.icon} />
      </span>
      <span>
        <b className="match-signer__name">{player.you ? `${player.name} (you)` : player.name}</b>
        <span className="match-muted match-block">{state.text}</span>
      </span>
    </>
  )
}
