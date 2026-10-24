import { Icon } from '../../components/Icon'
import type { Match } from './match'

// A match's status as match.js's `status()` draws it: the Live marker, or an
// `.fm-status` with its icon for every other state.
export function MatchStatus({ match }: { match: Match }) {
  switch (match.state) {
    case 'live':
      return <span className="live-marker">Live</span>
    case 'final':
      return <span className="fm-status">Final</span>
    case 'offline':
      return <span className="fm-status fm-status--offline">Scorer offline</span>
    case 'conflict':
      return (
        <span className="fm-status fm-status--conflict">
          <Icon name="alert" />
          Needs decision
        </span>
      )
    case 'upcoming':
      return match.called ? (
        <span className="fm-status">
          <Icon name="check" />
          Called
        </span>
      ) : (
        <span className="fm-status">
          <Icon name="clock" />
          <span className="num">{match.start}</span>
        </span>
      )
  }
}
