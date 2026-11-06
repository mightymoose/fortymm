import { Icon } from '../../../components/Icon'
import { other, type MatchRecord } from './match'

// The match's one status signal, as the design system's match row draws it.
export function MatchStatus({ match }: { match: MatchRecord }) {
  const { status } = match
  switch (status.kind) {
    case 'new':
      return <span className="fm-status">Not started</span>
    case 'live':
      return <span className="live-marker">Live</span>
    case 'disputed':
      return (
        <span className="fm-status fm-status--conflict">
          <Icon name="alert" />
          Scores disagree
        </span>
      )
    case 'awaiting': {
      const waitingOn = match.players[other(status.signedBy)]
      return (
        <span className="fm-status">
          <Icon name="clock" />
          {waitingOn.you ? 'Waiting for you' : `Waiting for ${waitingOn.name}`}
        </span>
      )
    }
    case 'final':
      return <span className="fm-status">Final</span>
  }
}
