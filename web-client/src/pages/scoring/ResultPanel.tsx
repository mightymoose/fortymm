import { Icon } from '../../components/Icon'
import type { Match, Viewer } from '../../scoring/demoMatches'

// A note for a spectator about who submits the result.
export function ResultPanel({ match, viewer }: { match: Match; viewer: Viewer }) {
  if (viewer.role !== 'spectator') return null
  return (
    <section className="score-result" aria-label="Result">
      <p className="fm-notice">
        <Icon name="info" />
        <span>
          <b>{match.players[0].name}</b> or <b>{match.players[1].name}</b> submits the result when
          the match ends.
        </span>
      </p>
    </section>
  )
}
