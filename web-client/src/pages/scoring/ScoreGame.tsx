import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLoaderData, useNavigate, useRouteContext } from '@tanstack/react-router'
import { useId, useRef, useState, type ReactNode } from 'react'
import { sessionQuery } from '../../api/queries'
import { Button } from '../../components/Button'
import { closeDialog } from '../../components/closeDialog'
import { FieldError } from '../../components/FieldError'
import { Icon } from '../../components/Icon'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { Sheet } from '../../components/Sheet'
import { useToast } from '../../components/toastContext'
import { Wordmark } from '../../components/Wordmark'
import {
  deciderGame,
  parseGameScore,
  reviewBoard,
  tally,
  winnerOf,
  type GamePoints,
  type Side,
} from '../../scoring/board'
import { viewerOf, type Match, type Viewer } from '../../scoring/demoMatches'
import {
  clearGame,
  reopen,
  saveGame,
  slotsOf,
  submitResult,
  useScratchpad,
  type SavedGame,
  type Scorer,
  type Submission,
} from '../../scoring/scratchpad'
import './scoring.css'

const ROUTE = '/_authenticated/matches/$matchId/scores/game/$gameNumber/edit'
const PATH = '/matches/$matchId/scores/game/$gameNumber/edit'

// The two sides as the page shows them, left then right. Swapping changes
// only the page, never the order the points are stored in.
type Sides = [Side, Side]

function other(side: Side): Side {
  return side === 0 ? 1 : 0
}

// A score as the page shows it, left side first.
function shown(points: GamePoints, sides: Sides): string {
  return `${points[sides[0]]}–${points[sides[1]]}`
}

// The games each side won, the winner's first, such as "3–1".
function games(won: [number, number], winner: Side): string {
  return `${won[winner]}–${won[other(winner)]}`
}

// The scratchpad of one match, open at one game. Anyone who can open the
// match can enter or change any game, in any order, as long as each game's
// score is legal. The match rules apply only when a player reviews the
// board to submit it.
export function ScoreGame() {
  const { match, gameNumber } = useLoaderData({ from: ROUTE })
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const me: Scorer = { playerId: account.player.id, name: account.player.display_name }
  const viewer = viewerOf(match, me.playerId)
  const pad = useScratchpad(match.id)
  const [left, setLeft] = useState<Side>(viewer.role === 'player' ? viewer.side : 0)
  const sides: Sides = [left, other(left)]
  const slots = slotsOf(pad, match.bestOf)
  const saved = pad.games[gameNumber]

  return (
    <div className="score">
      <header className="score-top">
        <Wordmark />
        <Link to="/" className="fm-btn fm-btn--ghost fm-btn--sm">
          <Icon name="back" />
          Home
        </Link>
      </header>
      <main className="score-content">
        <section className="score-match" aria-label="Match">
          <div className="score-players">
            <PlayerName name={match.players[sides[0]].name} />
            <p className="score-tally">
              <span className="fm-sr">Games </span>
              {shown(tally(slots), sides)}
            </p>
            <PlayerName name={match.players[sides[1]].name} end />
          </div>
          <Button variant="ghost" size="sm" onClick={() => setLeft(other(left))}>
            Swap sides
          </Button>
        </section>
        <GameStrip match={match} slots={slots} current={gameNumber} sides={sides} />
        <ScorePad
          key={`${gameNumber}:${saved?.points.join('-') ?? ''}`}
          match={match}
          gameNumber={gameNumber}
          saved={saved}
          slots={slots}
          sides={sides}
          frozen={pad.submission.phase === 'submitted'}
          me={me}
        />
        <Result match={match} submission={pad.submission} viewer={viewer} slots={slots} sides={sides} me={me} />
      </main>
    </div>
  )
}

function PlayerName({ name, end = false }: { name: string; end?: boolean }) {
  return (
    <p className={end ? 'score-player score-player--end' : 'score-player'}>
      <PlayerAvatar name={name} />
      <span className="score-player__name">{name}</span>
    </p>
  )
}

function GameStrip({
  match,
  slots,
  current,
  sides,
}: {
  match: Match
  slots: (GamePoints | null)[]
  current: number
  sides: Sides
}) {
  const decider = deciderGame(slots, match.bestOf)
  return (
    <nav className="score-strip-wrap" aria-label="Games">
      <ol className="score-strip">
        {slots.map((points, index) => {
          const game = index + 1
          const classes = ['score-slot']
          if (decider !== null && game > decider) classes.push('score-slot--after')
          return (
            <li key={game}>
              <Link
                to={PATH}
                params={{ matchId: match.id, gameNumber: String(game) }}
                className={classes.join(' ')}
                aria-current={game === current ? 'page' : undefined}
              >
                <span className="score-slot__label">Game {game}</span>{' '}
                <span className="score-slot__pts">
                  {points ? <SlotScore points={points} sides={sides} /> : '–'}
                </span>
              </Link>
            </li>
          )
        })}
      </ol>
      {decider !== null && decider < match.bestOf && (
        <p className="fm-help">Match decided after game {decider}</p>
      )}
    </nav>
  )
}

// A game's score, left side first, with the winner's points in bold.
function SlotScore({ points, sides }: { points: GamePoints; sides: Sides }) {
  const winner = winnerOf(points)
  const part = (side: Side) => (side === winner ? <b>{points[side]}</b> : <span>{points[side]}</span>)
  return (
    <>
      {part(sides[0])}–{part(sides[1])}
    </>
  )
}

function ScorePad({
  match,
  gameNumber,
  saved,
  slots,
  sides,
  frozen,
  me,
}: {
  match: Match
  gameNumber: number
  saved: SavedGame | undefined
  slots: (GamePoints | null)[]
  sides: Sides
  frozen: boolean
  me: Scorer
}) {
  const navigate = useNavigate()
  const showToast = useToast()
  const feedbackId = useId()
  // In the match's player order, like the stored points.
  const [draft, setDraft] = useState<[string, string]>(
    saved ? [String(saved.points[0]), String(saved.points[1])] : ['', ''],
  )
  const entry = parseGameScore(draft[0], draft[1])
  const invalid = entry.kind === 'malformed' || entry.kind === 'illegal'

  function feedback(): ReactNode {
    switch (entry.kind) {
      case 'empty':
      case 'legal':
        return null
      case 'partial':
        return (
          <p className="fm-help" id={feedbackId}>
            Enter both scores to save the game.
          </p>
        )
      case 'malformed':
        return <FieldError id={feedbackId}>Enter each score as a whole number, up to 99.</FieldError>
      case 'illegal':
        return <FieldError id={feedbackId}>{entry.reason}</FieldError>
    }
  }
  const message = feedback()

  function save() {
    if (entry.kind !== 'legal' || !saveGame(match.id, gameNumber, entry.points, me)) return
    const [high, low] = [entry.points[entry.winner], entry.points[other(entry.winner)]]
    showToast(`Game ${gameNumber} saved. ${high}–${low}.`)
    const after = slots.map((points, index) => (index === gameNumber - 1 ? entry.points : points))
    // Once the match is decided, the next empty game would only be an extra
    // one, so the page stays.
    if (deciderGame(after, match.bestOf) !== null) return
    const next = after.findIndex((points, index) => index >= gameNumber && points === null)
    if (next !== -1) {
      void navigate({ to: PATH, params: { matchId: match.id, gameNumber: String(next + 1) } })
    }
  }

  function clear() {
    if (clearGame(match.id, gameNumber)) showToast(`Game ${gameNumber} cleared.`)
  }

  return (
    <section className="score-pad" aria-labelledby={`${feedbackId}-title`}>
      <h1 className="h3 score-pad__title" id={`${feedbackId}-title`}>
        Game {gameNumber}
      </h1>
      <div className="fm-scorepad">
        {sides.map((side) => (
          <label key={side} className="fm-scorepad__side">
            <span className="fm-scorepad__name">{match.players[side].name}</span>
            <input
              className="fm-input fm-input--num score-input"
              inputMode="numeric"
              autoComplete="off"
              maxLength={3}
              value={draft[side]}
              disabled={frozen}
              aria-invalid={invalid || undefined}
              aria-describedby={message ? feedbackId : undefined}
              onChange={(event) => {
                const next: [string, string] = [...draft]
                next[side] = event.target.value
                setDraft(next)
              }}
            />
          </label>
        ))}
      </div>
      {message}
      {saved && <p className="fm-help">Saved by {saved.savedBy.name}</p>}
      {!frozen && (
        <div className="score-pad__actions">
          <Button variant="primary" disabled={entry.kind !== 'legal'} onClick={save}>
            Save game {gameNumber}
          </Button>
          {saved && (
            <Button variant="ghost" onClick={clear}>
              Clear game
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

// What the page offers about the match's result: a review for a player, a
// note for a spectator, or the submitted result.
function Result({
  match,
  submission,
  viewer,
  slots,
  sides,
  me,
}: {
  match: Match
  submission: Submission
  viewer: Viewer
  slots: (GamePoints | null)[]
  sides: Sides
  me: Scorer
}) {
  if (submission.phase === 'submitted') {
    const submitter = match.players.find((player) => player.id === submission.by)
    const waitingFor = match.players.find((player) => player.id !== submission.by)
    return (
      <section className="score-result" aria-label="Result">
        <p className="fm-notice fm-notice--success" role="status">
          <Icon name="check" />
          <span>
            Submitted by <b>{submitter?.name ?? 'a player'}</b>.{' '}
            <b>{match.players[submission.winner].name}</b> wins{' '}
            {games(tally(submission.games), submission.winner)}.
          </span>
        </p>
        {waitingFor && <p className="fm-help">Waiting for {waitingFor.name}</p>}
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
  return <ReviewResult match={match} slots={slots} sides={sides} me={me} />
}

function ReviewResult({
  match,
  slots,
  sides,
  me,
}: {
  match: Match
  slots: (GamePoints | null)[]
  sides: Sides
  me: Scorer
}) {
  const sheet = useRef<HTMLDialogElement>(null)
  const review = reviewBoard(slots, match.bestOf)
  const name = (side: Side) => match.players[side].name

  function submit() {
    if (review.kind !== 'decided') return
    submitResult(match.id, { by: me.playerId, games: review.games, winner: review.winner })
    sheet.current?.close()
  }

  function body(): ReactNode {
    switch (review.kind) {
      case 'decided':
        return (
          <>
            <p className="h3 score-review__winner">
              {name(review.winner)} wins {games(review.tally, review.winner)}
            </p>
            <ol className="score-review__games">
              {review.games.map((points, index) => (
                <li key={index}>
                  <span>Game {index + 1}</span>{' '}
                  <span className="score-review__pts">
                    <SlotScore points={points} sides={sides} />
                  </span>
                </li>
              ))}
            </ol>
            {review.closedGaps && (
              <p className="fm-notice">
                <Icon name="info" />
                <span>Empty games were left out, so the games after them move up.</span>
              </p>
            )}
          </>
        )
      case 'undecided': {
        const count = (won: number) => (won === 1 ? '1 game' : `${won} games`)
        return (
          <p className="fm-notice">
            <Icon name="info" />
            <span>
              {name(0)} has {count(review.tally[0])} and {name(1)} has {count(review.tally[1])}.
              Nobody has won {review.gamesToWin} games yet.
            </span>
          </p>
        )
      }
      case 'overrun':
        return (
          <>
            <p className="fm-notice fm-notice--warning">
              <Icon name="alert" />
              <span>
                The match was decided after game {review.decidedAtGame}, but{' '}
                {review.extraGames.map((game) => `game ${game}`).join(', ')}{' '}
                {review.extraGames.length === 1 ? 'has a score' : 'have scores'}. Clear{' '}
                {review.extraGames.length === 1 ? 'it' : 'them'}, or fix the games before it.
              </span>
            </p>
            <ul className="score-review__links">
              {review.extraGames.map((game) => (
                <li key={game}>
                  <Link
                    to={PATH}
                    params={{ matchId: match.id, gameNumber: String(game) }}
                    onClick={(event) => event.currentTarget.closest('dialog')?.close()}
                  >
                    Go to game {game}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )
    }
  }

  return (
    <section className="score-result" aria-label="Result">
      <Button variant="secondary" onClick={() => sheet.current?.showModal()}>
        Review result
      </Button>
      <Sheet
        ref={sheet}
        title="Review result"
        subtitle={`${name(0)} v ${name(1)}`}
        footer={
          review.kind === 'decided' ? (
            <Button variant="primary" onClick={submit}>
              Submit result
            </Button>
          ) : (
            <Button variant="secondary" onClick={closeDialog}>
              Keep scoring
            </Button>
          )
        }
      >
        {body()}
      </Sheet>
    </section>
  )
}
