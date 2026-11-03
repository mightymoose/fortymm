import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { matchWinner, tally } from '../../scoring/board'
import type { Match, Viewer } from '../../scoring/demoMatches'
import { reopen, type Scorer, type Submission } from '../../scoring/scratchpad'
import { gamesWon, midSentence, playerLabel, wins } from './sides'

// The submitted result, or a note for a spectator about who submits it. A
// player submits through the pad's button.
export function ResultPanel({
  match,
  submission,
  resultUnsynced,
  stuck,
  viewer,
  me,
}: {
  match: Match
  submission: Submission
  resultUnsynced: boolean
  stuck: boolean
  viewer: Viewer
  me: Scorer
}) {
  if (submission.phase === 'submitted') {
    const label = (playerId: string) => playerLabel(match, viewer, playerId, 'a player')
    const waitingFor = match.players.find((player) => player.id !== submission.by)
    const winner = matchWinner(submission.games)
    return (
      <section className="score-result" aria-label="Result">
        <p className="fm-notice fm-notice--success" role="status">
          <Icon name="check" />
          <span>
            Submitted by <b>{midSentence(label(submission.by))}</b>.{' '}
            {wins(label(match.players[winner].id), gamesWon(tally(submission.games), winner))}.
          </span>
        </p>
        <p className="fm-help">
          {resultUnsynced
            ? stuck
              ? 'Saved on this device. It reaches the server when you’re back online.'
              : 'Syncing the result…'
            : waitingFor && `Waiting for ${midSentence(label(waitingFor.id))}`}
        </p>
        {submission.by === me.playerId && (
          <Button variant="secondary" onClick={() => reopen(match.id)}>
            Edit scores
          </Button>
        )}
      </section>
    )
  }
  if (viewer.role === 'spectator') {
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
  return null
}
