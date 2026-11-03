import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLoaderData, useNavigate, useParams, useRouteContext, useSearch } from '@tanstack/react-router'
import { useId, useRef, useState, type ReactNode } from 'react'
import { ApiError, classifyFailure } from '../../api/errors'
import { sessionQuery } from '../../api/queries'
import { Button } from '../../components/Button'
import { closeDialog } from '../../components/closeDialog'
import { FieldError } from '../../components/FieldError'
import { Icon } from '../../components/Icon'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { QueryBoundary } from '../../components/QueryBoundary'
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
  deleteGame,
  deleteResult,
  matchQuery,
  parseNetwork,
  postResult,
  putGame,
  type Network,
} from '../../scoring/demoServer'
import { slotsOf, useScratchpad, type SavedGame, type Scorer, type Submission } from '../../scoring/scratchpad'
import './scoring.css'

const ROUTE = '/_authenticated/matches/$matchId/scores/game/$gameNumber/edit'
const PATH = '/matches/$matchId/scores/game/$gameNumber/edit'

// The two sides as the page shows them, left then right: the viewer's side
// first when they play. The points stay stored in the match's order.
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
  const { gameNumber } = useLoaderData({ from: ROUTE })
  return (
    <div className="score-page">
      <header className="score-top">
        <Wordmark />
        <Link to="/" className="fm-btn fm-btn--ghost fm-btn--sm">
          <Icon name="back" />
          Home
        </Link>
      </header>
      <main className="score-content">
        <h1 className="score-title">Game {gameNumber}</h1>
        <QueryBoundary skeleton={<ScoreSkeleton />}>
          <ScoreBoard gameNumber={gameNumber} />
        </QueryBoundary>
      </main>
    </div>
  )
}

function ScoreSkeleton() {
  return (
    <div className="score-skeleton" aria-busy="true" aria-label="Loading the match">
      <div className="fm-skeleton score-skeleton__pad" aria-hidden="true" />
      <div className="fm-skeleton score-skeleton__button" aria-hidden="true" />
      <div className="fm-skeleton score-skeleton__strip" aria-hidden="true" />
    </div>
  )
}

function useNetwork(): Network {
  return parseNetwork(useSearch({ from: ROUTE }).network)
}

function ScoreBoard({ gameNumber }: { gameNumber: number }) {
  const { matchId } = useParams({ from: ROUTE })
  const { api } = useRouteContext({ from: '__root__' })
  const network = useNetwork()
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const me: Scorer = { playerId: account.player.id, name: account.player.display_name }
  const { data: match } = useSuspenseQuery(
    matchQuery(matchId, { id: me.playerId, name: me.name }, network),
  )
  const viewer = viewerOf(match, me.playerId)
  const pad = useScratchpad(match.id)
  const left: Side = viewer.role === 'player' ? viewer.side : 0
  const sides: Sides = [left, other(left)]
  const slots = slotsOf(pad, match.bestOf)
  const saved = pad.games[gameNumber]

  return (
    <>
      <ScorePad
        key={`${gameNumber}:${saved?.points.join('-') ?? ''}`}
        match={match}
        gameNumber={gameNumber}
        saved={saved}
        slots={slots}
        sides={sides}
        frozen={pad.submission.phase === 'submitted'}
        me={me}
        network={network}
      />
      <GameStrip match={match} slots={slots} current={gameNumber} sides={sides} />
      <Result
        match={match}
        submission={pad.submission}
        viewer={viewer}
        slots={slots}
        sides={sides}
        me={me}
        network={network}
      />
    </>
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
      <p className="score-strip__label">Games</p>
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
                search={true}
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

// A write that failed: what didn't happen, why, and Try again when another
// try could work. A 409 means the result was submitted meanwhile, so the
// board is frozen and trying again can't help.
function WriteError({ what, error, onRetry }: { what: string; error: Error; onRetry: () => void }) {
  const titleId = useId()
  const frozen = error instanceof ApiError && error.status === 409
  const sentence = frozen
    ? 'A player submitted the result, so the scores are frozen.'
    : classifyFailure(error).kind === 'unreachable'
      ? 'FortyMM isn’t answering. Check your connection, then try again.'
      : 'Something went wrong on our side. Try again. If it keeps happening, tell us what you were doing.'
  return (
    <div className="fm-alert fm-alert--error" role="alert" aria-labelledby={titleId}>
      <Icon name="error" />
      <p className="fm-alert__title" id={titleId}>
        Couldn’t {what}
      </p>
      <p className="fm-alert__body">{sentence}</p>
      {!frozen && (
        <div className="fm-alert__actions">
          <Button variant="primary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
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
  network,
}: {
  match: Match
  gameNumber: number
  saved: SavedGame | undefined
  slots: (GamePoints | null)[]
  sides: Sides
  frozen: boolean
  me: Scorer
  network: Network
}) {
  const navigate = useNavigate()
  const showToast = useToast()
  const feedbackId = useId()
  // In the match's player order, like the stored points.
  const [draft, setDraft] = useState<[string, string]>(
    saved ? [String(saved.points[0]), String(saved.points[1])] : ['', ''],
  )
  const inputs = useRef<[HTMLInputElement | null, HTMLInputElement | null]>([null, null])
  const entry = parseGameScore(draft[0], draft[1])
  const invalid = entry.kind === 'malformed' || entry.kind === 'illegal'

  // The callbacks live on the mutations, not on mutate(), because a saved
  // game remounts this pad before the request's promise settles.
  const saveMutation = useMutation({
    mutationFn: (points: GamePoints) => putGame(match.id, gameNumber, points, me, network),
    onSuccess: (_, points) => {
      const winner = winnerOf(points)
      showToast(`Game ${gameNumber} saved. ${points[winner]}–${points[other(winner)]}.`)
      const after = slots.map((slot, index) => (index === gameNumber - 1 ? points : slot))
      // Once the match is decided, the next empty game would only be an extra
      // one, so the page stays.
      if (deciderGame(after, match.bestOf) !== null) return
      const next = after.findIndex((slot, index) => index >= gameNumber && slot === null)
      if (next !== -1) {
        void navigate({ to: PATH, params: { matchId: match.id, gameNumber: String(next + 1) }, search: true })
      }
    },
  })
  const clearMutation = useMutation({
    mutationFn: () => deleteGame(match.id, gameNumber, network),
    onSuccess: () => showToast(`Game ${gameNumber} cleared.`),
  })
  const busy = saveMutation.isPending || clearMutation.isPending

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
    if (entry.kind !== 'legal' || busy) return
    clearMutation.reset()
    saveMutation.mutate(entry.points)
  }

  function clear() {
    if (busy) return
    saveMutation.reset()
    clearMutation.mutate()
  }

  const side = (side: Side) => {
    const name = match.players[side].name
    return (
      <div className="score-side">
        <p className="score-player">
          <PlayerAvatar name={name} />
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
          // The left score is where a game's entry starts.
          autoFocus={side === sides[0] && !frozen}
          disabled={frozen}
          // Read-only rather than disabled while a write is in flight, so
          // focus stays put if it fails.
          readOnly={busy}
          aria-label={name}
          aria-invalid={invalid || undefined}
          aria-describedby={message ? feedbackId : undefined}
          onChange={(event) => {
            const next: [string, string] = [...draft]
            next[side] = event.target.value
            setDraft(next)
          }}
          onKeyDown={(event) => {
            // Enter moves on to the other score while it's empty, and saves
            // once both are in.
            if (event.key !== 'Enter' || draft[other(side)] !== '') return
            event.preventDefault()
            inputs.current[other(side)]?.focus()
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
        save()
      }}
    >
      <section className="score-pad" aria-label="Match">
        {side(sides[0])}
        <div className="score-mid">
          <span className="score-mid__vs">vs</span>
          <p className="score-tally">
            <span className="fm-sr">Games </span>
            {shown(tally(slots), sides)}
          </p>
        </div>
        {side(sides[1])}
      </section>
      {message}
      {saveMutation.isError && (
        <WriteError what={`save game ${gameNumber}`} error={saveMutation.error} onRetry={save} />
      )}
      {clearMutation.isError && (
        <WriteError what={`clear game ${gameNumber}`} error={clearMutation.error} onRetry={clear} />
      )}
      {!frozen && (
        <div className="score-actions">
          <p className="fm-help score-actions__note">{saved ? `Saved by ${saved.savedBy.name}` : ''}</p>
          <div className="score-actions__buttons">
            {saved && (
              <Button
                variant="ghost"
                onClick={clear}
                disabled={saveMutation.isPending}
                aria-busy={clearMutation.isPending || undefined}
              >
                {clearMutation.isPending ? 'Clearing…' : 'Clear game'}
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={entry.kind !== 'legal' || clearMutation.isPending}
              aria-busy={saveMutation.isPending || undefined}
            >
              {saveMutation.isPending ? 'Saving…' : `Save game ${gameNumber}`}
            </Button>
          </div>
        </div>
      )}
    </form>
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
  network,
}: {
  match: Match
  submission: Submission
  viewer: Viewer
  slots: (GamePoints | null)[]
  sides: Sides
  me: Scorer
  network: Network
}) {
  if (submission.phase === 'submitted') {
    return <Submitted match={match} submission={submission} me={me} network={network} />
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
  return <ReviewResult match={match} slots={slots} sides={sides} me={me} network={network} />
}

function Submitted({
  match,
  submission,
  me,
  network,
}: {
  match: Match
  submission: Extract<Submission, { phase: 'submitted' }>
  me: Scorer
  network: Network
}) {
  const reopenMutation = useMutation({ mutationFn: () => deleteResult(match.id, network) })
  const submitter = match.players.find((player) => player.id === submission.by)
  const waitingFor = match.players.find((player) => player.id !== submission.by)
  const reopen = () => reopenMutation.mutate()
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
      {reopenMutation.isError && (
        <WriteError what="reopen the scores" error={reopenMutation.error} onRetry={reopen} />
      )}
      {submission.by === me.playerId && (
        <Button variant="secondary" onClick={reopen} aria-busy={reopenMutation.isPending || undefined}>
          {reopenMutation.isPending ? 'Reopening…' : 'Edit scores'}
        </Button>
      )}
    </section>
  )
}

function ReviewResult({
  match,
  slots,
  sides,
  me,
  network,
}: {
  match: Match
  slots: (GamePoints | null)[]
  sides: Sides
  me: Scorer
  network: Network
}) {
  const sheet = useRef<HTMLDialogElement>(null)
  const review = reviewBoard(slots, match.bestOf)
  const name = (side: Side) => match.players[side].name
  const submitMutation = useMutation({
    mutationFn: (submission: { games: GamePoints[]; winner: Side }) =>
      postResult(match.id, { by: me.playerId, ...submission }, network),
    onSuccess: () => sheet.current?.close(),
  })

  function submit() {
    if (review.kind !== 'decided' || submitMutation.isPending) return
    submitMutation.mutate({ games: review.games, winner: review.winner })
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
            {submitMutation.isError && (
              <WriteError what="submit the result" error={submitMutation.error} onRetry={submit} />
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
                    search={true}
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
      <Button
        variant="secondary"
        onClick={() => {
          submitMutation.reset()
          sheet.current?.showModal()
        }}
      >
        Review result
      </Button>
      <Sheet
        ref={sheet}
        title="Review result"
        subtitle={`${name(0)} v ${name(1)}`}
        footer={
          review.kind === 'decided' ? (
            <Button variant="primary" onClick={submit} aria-busy={submitMutation.isPending || undefined}>
              {submitMutation.isPending ? 'Submitting…' : 'Submit result'}
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
