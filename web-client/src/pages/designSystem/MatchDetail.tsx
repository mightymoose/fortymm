import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { DetailList } from '../../components/DetailList'
import { Icon } from '../../components/Icon'
import { ScrollArea } from '../../components/ScrollArea'
import { useToast } from '../../components/toastContext'
import { useTooltip } from '../../components/tooltipContext'
import { DemoButton } from './DemoButton'
import { GameScores } from './GameScores'
import { shortName, type Match, type Rest } from './match'
import { MatchRow } from './MatchRow'
import { MatchStatus } from './MatchStatus'
import { scoringScreenUrl } from './referenceLinks'

// An action that works on the tournament screen. Here it only says so.
function useTournamentAction() {
  const showToast = useToast()
  return () => showToast('Works on the tournament screen, not in this gallery', { icon: 'info' })
}

// "Call to table" while a player rests: off, with the reason in its tooltip.
function RestingCallToTable({ rest }: { rest: Rest }) {
  const tooltip = useTooltip(`${rest.who} is resting until ${rest.until}`)
  return (
    <Button variant="primary" aria-disabled="true" {...tooltip}>
      Call to table
    </Button>
  )
}

// What a match needs decided, if anything: a scheduling conflict with its
// fix, or a scorer gone offline.
function MatchAlert({ match }: { match: Match }) {
  const act = useTournamentAction()
  if (match.state === 'conflict') {
    return (
      <div className="fm-alert fm-alert--warning" role="group" aria-label="Scheduling conflict">
        <Icon name="alert" />
        <p className="fm-alert__title">{match.conflict.title}</p>
        <p className="fm-alert__body">{match.conflict.body}</p>
        <div className="fm-alert__actions">
          <Button variant="primary" size="sm" onClick={act}>
            {match.conflict.fix}
          </Button>
          <Button variant="secondary" size="sm" onClick={act}>
            {`Keep ${match.start}`}
          </Button>
        </div>
      </div>
    )
  }
  if (match.state === 'offline') {
    return (
      <div className="fm-alert fm-alert--error" role="alert">
        <Icon name="offline" />
        <p className="fm-alert__title">Table {match.table} scorer is offline</p>
        <p className="fm-alert__body">
          Last score arrived at <span className="num">{match.offlineSince}</span>. Points
          entered on that device will sync when it reconnects.
        </p>
        <div className="fm-alert__actions">
          <Button variant="primary" size="sm" onClick={act}>
            Score from this device
          </Button>
          <Button variant="secondary" size="sm" onClick={act}>
            Send a reminder
          </Button>
        </div>
      </div>
    )
  }
  return null
}

// The actions a match's state allows, or none.
function MatchActions({ match, onWithdraw }: { match: Match; onWithdraw: () => void }) {
  const act = useTournamentAction()
  switch (match.state) {
    case 'live':
      return (
        <>
          <a className="fm-btn fm-btn--secondary" href={scoringScreenUrl}>
            Open scoring
          </a>
          <DemoButton variant="ghost">Move to another table</DemoButton>
        </>
      )
    case 'upcoming':
      return (
        <>
          {match.called ? (
            <Button variant="secondary" onClick={act}>
              Cancel call
            </Button>
          ) : match.rest ? (
            <RestingCallToTable rest={match.rest} />
          ) : (
            <Button variant="primary" onClick={act}>
              Call to table
            </Button>
          )}
          <DemoButton variant="ghost">Reschedule</DemoButton>
          <Button variant="danger" className="end" onClick={onWithdraw}>
            Withdraw a player…
          </Button>
        </>
      )
    case 'final':
      return (
        <>
          <DemoButton variant="secondary">Edit result</DemoButton>
          <DemoButton variant="ghost">Print score sheet</DemoButton>
        </>
      )
    default:
      return null
  }
}

// A match's details as match.js's `detail()` draws them, on a Card: the
// players and score, what needs deciding, the game scores, when and where
// it's played, then the actions its state allows. The actions that would
// change the tournament only say so in a toast. "Withdraw a player…" calls
// `onWithdraw`.
export function MatchDetail({ match, onWithdraw }: { match: Match; onWithdraw: () => void }) {
  const [first, second] = match.players
  const hasActions = match.state === 'live' || match.state === 'upcoming' || match.state === 'final'
  return (
    <Card
      title={`${shortName(first)} vs ${shortName(second)}`}
      subtitle={`${match.event} · ${match.round}`}
      status={<MatchStatus match={match} />}
      actions={hasActions && <MatchActions match={match} onWithdraw={onWithdraw} />}
    >
      <MatchRow match={match} large headHidden clubs />
      <MatchAlert match={match} />
      {match.games.length > 0 && (
        <div>
          <h4 className="fm-section-title" style={{ marginBottom: 8 }}>
            Game scores
          </h4>
          <ScrollArea>
            <GameScores match={match} />
          </ScrollArea>
        </div>
      )}
      <DetailList
        details={[
          { term: 'Event', value: match.event },
          { term: 'Round', value: match.round },
          { term: 'Table', value: `Table ${match.table}` },
          match.state === 'final'
            ? { term: 'Played', value: `${match.start}–${match.end}` }
            : { term: 'Start', value: match.start },
        ]}
      />
    </Card>
  )
}
