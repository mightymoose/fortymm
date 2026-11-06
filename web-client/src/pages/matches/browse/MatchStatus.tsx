import { Icon } from '../../../components/Icon'
import { yourSide, type MatchRecord, type Side } from './sampleMatches'

// The match's one status signal, as the design system's match row draws it.
export function MatchStatus({ match }: { match: MatchRecord }) {
  const { status } = match
  switch (status.kind) {
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
      const waitingOn = match.players[status.signedBy === 0 ? 1 : 0]
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

// A side's rating change from a final rated match, signed with its arrow.
// Without `side`, the viewer's.
export function RatingChange({ match, side }: { match: MatchRecord; side?: Side }) {
  if (match.status.kind !== 'final' || match.status.rating === null) return null
  const which = side ?? yourSide(match)
  if (which === null) return null
  const delta = match.status.rating[which]
  return delta >= 0 ? (
    <span className="rating-up">▲ +{delta}</span>
  ) : (
    <span className="rating-down">▼ −{Math.abs(delta)}</span>
  )
}
