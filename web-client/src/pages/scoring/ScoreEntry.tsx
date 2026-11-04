import { useNavigate } from '@tanstack/react-router'
import { useId, useRef, useState, type ReactNode } from 'react'
import { classifyFailure, failureMessages } from '../../api/errors'
import { Button } from '../../components/Button'
import { FieldError } from '../../components/FieldError'
import { Icon } from '../../components/Icon'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { otherSide, parseGameScore, tally, type GamePoints, type Side } from '../../scoring/board'
import { saveBoard } from '../../scoring/boards'
import type { Match, Viewer } from '../../scoring/demoMatches'
import { draftHash, gamesOf, nowSeconds, replacesOf, type Fragment } from '../../scoring/fragment'
import { planPress, slotsOf } from '../../scoring/planPress'
import type { SubmitResult } from './useSubmitResult'
import { gamesWon, PATH, playerLabel, shown, wins, type Sides } from './sides'

// The pad that edits one game: a score input per player with the games
// tally between them, then the actions. A save puts the games in the URL,
// on this device, and the page moves on at once. The board then syncs in
// the background, for whoever watches the match.
export function ScoreEntry({
  match,
  gameNumber,
  fragment,
  viewer,
  sides,
  submit,
}: {
  match: Match
  gameNumber: number
  fragment: Fragment
  viewer: Viewer
  sides: Sides
  submit: SubmitResult
}) {
  const navigate = useNavigate()
  const feedbackId = useId()
  const games = gamesOf(fragment)
  const saved = games[gameNumber - 1]
  // In the match's player order, like the stored points.
  const [draft, setDraft] = useState<[string, string]>(saved ? [String(saved[0]), String(saved[1])] : ['', ''])
  const inputs = useRef<[HTMLInputElement | null, HTMLInputElement | null]>([null, null])
  const entry = parseGameScore(draft[0], draft[1])
  const invalid = entry.kind === 'malformed' || entry.kind === 'illegal'
  const press = planPress(games, viewer, gameNumber, entry, match.bestOf)

  const failure = submit.error && failureMessages[classifyFailure(submit.error).kind]

  async function show(next: GamePoints[], game: number) {
    const hash = draftHash(match, next, await replacesOf(fragment), nowSeconds())
    saveBoard(match.id, hash)
    await navigate({
      to: PATH,
      params: { matchId: match.id, gameNumber: String(game) },
      search: true,
      hash,
      replace: game === gameNumber,
    })
  }

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
      case 'save': {
        const next = [...games]
        next[gameNumber - 1] = press.points
        void show(next, press.next ?? gameNumber)
        return
      }
      case 'submit':
        if (viewer.role === 'player' && !submit.isPending) {
          submit.mutate({ submitted: press.games, side: viewer.side, gameNumber })
        }
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
          autoFocus={side === sides[0]}
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
            {shown(tally(slotsOf(games, match.bestOf)), sides)}
          </p>
        </div>
        {side(sides[1])}
      </section>
      <div className="score-actions">
        {/* A line that keeps its height, so typing doesn't move the buttons. */}
        <div className="score-actions__note">
          {message ??
            (press.kind === 'submit' && (
              <span className="fm-help">
                {wins(playerLabel(match, viewer, match.players[press.winner].id), gamesWon(tally(press.games), press.winner))}
              </span>
            ))}
        </div>
        <div className="score-actions__buttons">
          {/* Only the last game clears, so the games never have a gap. */}
          {saved && gameNumber === games.length && (
            <Button variant="secondary" onClick={() => void show(games.slice(0, -1), gameNumber)}>
              Clear game
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={press.kind === 'disabled'} busy={submit.isPending}>
            {press.kind === 'submit' ? (submit.isPending ? 'Submitting…' : 'Submit result') : `Save game ${gameNumber}`}
          </Button>
        </div>
      </div>
      {failure && (
        <div className="fm-alert fm-alert--error" role="alert">
          <Icon name="error" />
          <p className="fm-alert__title">{failure.title}</p>
          <p className="fm-alert__body">{failure.sentence}</p>
        </div>
      )}
    </form>
  )
}
