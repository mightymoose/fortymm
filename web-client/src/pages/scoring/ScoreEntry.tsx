import { useNavigate } from '@tanstack/react-router'
import { useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../components/Button'
import { FieldError } from '../../components/FieldError'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { otherSide, parseGameScore, tally, type Side } from '../../scoring/board'
import type { Match, Viewer } from '../../scoring/demoMatches'
import { planPress } from '../../scoring/planPress'
import { clearGame, saveGame, slotsOf, submitResult, type Board, type Scorer } from '../../scoring/scratchpad'
import { gamesWon, midSentence, PATH, playerLabel, shown, wins, type Sides } from './sides'

// The pad that edits one game: a score input per player with the games
// tally between them, then the actions. A save stays on this device and the
// page moves on at once.
export function ScoreEntry({
  match,
  gameNumber,
  board,
  viewer,
  sides,
  me,
}: {
  match: Match
  gameNumber: number
  board: Board
  viewer: Viewer
  sides: Sides
  me: Scorer
}) {
  const navigate = useNavigate()
  const feedbackId = useId()
  const saved = board.games[gameNumber]
  const frozen = board.submission.phase === 'submitted'
  // In the match's player order, like the stored points.
  const [draft, setDraft] = useState<[string, string]>(
    saved ? [String(saved.points[0]), String(saved.points[1])] : ['', ''],
  )
  const inputs = useRef<[HTMLInputElement | null, HTMLInputElement | null]>([null, null])
  const entry = parseGameScore(draft[0], draft[1])
  const invalid = entry.kind === 'malformed' || entry.kind === 'illegal'
  const press = planPress(board, viewer, gameNumber, entry, match.bestOf)

  const message = ((): ReactNode => {
    switch (entry.kind) {
      case 'empty':
      case 'legal':
        return null
      case 'partial':
        return (
          <span className="fm-help" id={feedbackId}>
            Enter both scores to save the game.
          </span>
        )
      case 'malformed':
        return <FieldError id={feedbackId}>Enter each score as a whole number, up to 99.</FieldError>
      case 'illegal':
        return <FieldError id={feedbackId}>{entry.reason}</FieldError>
    }
  })()

  function onPress() {
    switch (press.kind) {
      case 'disabled':
        return
      case 'save':
        if (!saveGame(match.id, gameNumber, press.points, me) || press.next === null) return
        void navigate({ to: PATH, params: { matchId: match.id, gameNumber: String(press.next) }, search: true })
        return
      case 'submit':
        if (press.save) saveGame(match.id, gameNumber, press.save, me)
        submitResult(match.id, me.playerId, press.games)
        void navigate({ to: '/matches/$matchId/scores/submission', params: { matchId: match.id }, search: true })
    }
  }

  const side = (side: Side) => {
    const name = playerLabel(match, viewer, match.players[side].id)
    return (
      <div className="score-side">
        <p className="score-player">
          {/* Initials of "You" or "Your opponent" would read as a name. */}
          {viewer.role === 'spectator' && <PlayerAvatar name={name} />}
          <span className="score-player__name">{name}</span>
        </p>
        <input
          ref={(input) => {
            inputs.current[side] = input
          }}
          className="score-input"
          inputMode="numeric"
          autoComplete="off"
          placeholder="0"
          maxLength={3}
          value={draft[side]}
          autoFocus={side === sides[0] && !frozen}
          disabled={frozen}
          aria-label={name}
          aria-invalid={invalid || undefined}
          aria-describedby={message ? feedbackId : undefined}
          onChange={(event) => {
            const next: [string, string] = [...draft]
            next[side] = event.target.value
            setDraft(next)
          }}
          onKeyDown={(event) => {
            // Enter moves on to the other score while it's empty. Once both
            // are in, it submits the form.
            if (event.key !== 'Enter' || draft[otherSide(side)] !== '') return
            event.preventDefault()
            inputs.current[otherSide(side)]?.focus()
          }}
        />
      </div>
    )
  }

  return (
    <form
      className="score-entry"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        onPress()
      }}
    >
      <section className="score-pad" aria-label="Match">
        {side(sides[0])}
        <div className="score-mid">
          <span className="score-mid__vs">vs</span>
          <p className="score-tally">
            <span className="fm-sr">Games </span>
            {shown(tally(slotsOf(board, match.bestOf)), sides)}
          </p>
        </div>
        {side(sides[1])}
      </section>
      {frozen ? (
        message
      ) : (
        <div className="score-actions">
          {/* A line that keeps its height, so typing doesn't move the buttons. */}
          <div className="score-actions__note">
            {message ??
              (press.kind === 'submit' ? (
                <span className="fm-help">
                  {wins(playerLabel(match, viewer, match.players[press.winner].id), gamesWon(tally(press.games), press.winner))}
                  {press.closedGaps && ', with the empty games left out'}
                </span>
              ) : (
                saved && (
                  <span className="fm-help">
                    Saved by {midSentence(playerLabel(match, viewer, saved.savedBy.playerId, saved.savedBy.name))}
                  </span>
                )
              ))}
          </div>
          <div className="score-actions__buttons">
            {saved && (
              <Button variant="secondary" onClick={() => clearGame(match.id, gameNumber)}>
                Clear game
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={press.kind === 'disabled'}>
              {press.kind === 'submit' ? 'Submit result' : `Save game ${gameNumber}`}
            </Button>
          </div>
        </div>
      )}
    </form>
  )
}
