import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLoaderData, useNavigate, useRouteContext, useSearch } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { sessionQuery } from '../../api/queries'
import { Button } from '../../components/Button'
import { closeDialog } from '../../components/closeDialog'
import { FieldError } from '../../components/FieldError'
import { Icon } from '../../components/Icon'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { Sheet } from '../../components/Sheet'
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
import { parseNetwork } from '../../scoring/demoServer'
import {
  clearGame,
  reopen,
  saveGame,
  slotsOf,
  submitResult,
  useScratchpad,
  type Change,
  type SavedGame,
  type Scorer,
  type Submitted,
} from '../../scoring/scratchpad'
import { useSync, type SyncStatus } from '../../scoring/sync'
import { TestingPanel } from './TestingPanel'
import './scoring.css'

const ROUTE = '/_authenticated/matches/$matchId/scores/game/$gameNumber/edit'
const PATH = '/matches/$matchId/scores/game/$gameNumber/edit'

// How long a game's "Synced" mark shows once its change reaches the server.
const SYNCED_MS = 1200

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

// The games whose save or clear hasn't reached the server.
function unsyncedGames(outbox: readonly Change[]): Set<number> {
  return new Set(outbox.flatMap((change) => ('game' in change ? [change.game] : [])))
}

// The scratchpad of one match, open at one game. Anyone who can open the
// match can enter or change any game, in any order, as long as each game's
// score is legal. A save stays on this device and syncs in the background.
// The match rules apply only when a player reviews the board to submit it.
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
        <ScoreBoard gameNumber={gameNumber} />
        <TestingPanel />
      </main>
    </div>
  )
}

// It reads the board from this device, never waiting on the network, and
// pulls the server's board in the background (see sync.ts). So it has no
// loading or error state of its own: with no connection and nothing saved,
// the board is empty.
function ScoreBoard({ gameNumber }: { gameNumber: number }) {
  const { match } = useLoaderData({ from: ROUTE })
  const { api } = useRouteContext({ from: '__root__' })
  const network = parseNetwork(useSearch({ from: ROUTE }).network)
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const me: Scorer = { playerId: account.player.id, name: account.player.display_name }
  const sync = useSync(match.id, network)
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
      />
      <GameStrip
        match={match}
        slots={slots}
        current={gameNumber}
        sides={sides}
        unsynced={unsyncedGames(pad.outbox)}
        sync={sync}
      />
      <Result
        match={match}
        submission={pad.submission}
        resultUnsynced={pad.outbox.some((change) => change.kind === 'submit' || change.kind === 'reopen')}
        sync={sync}
        viewer={viewer}
        slots={slots}
        sides={sides}
        me={me}
      />
    </>
  )
}

function GameStrip({
  match,
  slots,
  current,
  sides,
  unsynced,
  sync,
}: {
  match: Match
  slots: (GamePoints | null)[]
  current: number
  sides: Sides
  unsynced: Set<number>
  sync: SyncStatus
}) {
  const decider = deciderGame(slots, match.bestOf)
  return (
    <nav
      className="score-strip-wrap"
      aria-label="Games"
      aria-busy={sync.sending !== null || sync.pulling || undefined}
    >
      {/* One line that always holds its height, so a note never moves the
          page when it comes or goes. */}
      <div className="score-strip__head">
        <p className="score-strip__label">Games</p>
        {sync.stuck && unsynced.size > 0 ? (
          <SyncWaiting reason={sync.stuck} />
        ) : (
          decider !== null &&
          decider < match.bestOf && <p className="score-strip__note">Match decided after game {decider}</p>
        )}
      </div>
      <ol className="score-strip">
        {slots.map((points, index) => (
          <GameSlot
            key={index + 1}
            match={match}
            game={index + 1}
            points={points}
            current={index + 1 === current}
            after={decider !== null && index + 1 > decider}
            sides={sides}
            unsynced={unsynced.has(index + 1)}
            sending={sync.sending !== null && 'game' in sync.sending && sync.sending.game === index + 1}
            stuck={sync.stuck !== null}
          />
        ))}
      </ol>
    </nav>
  )
}

function SyncWaiting({ reason }: { reason: 'offline' | 'failed' }) {
  return (
    <p className="score-strip__note score-strip__note--waiting" role="status">
      {reason === 'offline' ? 'Offline. Saved on this device.' : 'Not synced yet. Saved on this device.'}
    </p>
  )
}

// One game in the strip, with where its last change stands. A dot while
// it's on its way to the server, a dashed amber edge while its sync is
// stuck, both while a stuck game tries again, and a moment of green once it
// lands. None of them changes the cell's size.
function GameSlot({
  match,
  game,
  points,
  current,
  after,
  sides,
  unsynced,
  sending,
  stuck,
}: {
  match: Match
  game: number
  points: GamePoints | null
  current: boolean
  after: boolean
  sides: Sides
  unsynced: boolean
  sending: boolean
  stuck: boolean
}) {
  const [justSynced, setJustSynced] = useState(false)
  const wasUnsynced = useRef(unsynced)
  useEffect(() => {
    const landed = wasUnsynced.current && !unsynced
    wasUnsynced.current = unsynced
    if (!landed) return
    setJustSynced(true)
    const timer = setTimeout(() => setJustSynced(false), SYNCED_MS)
    return () => clearTimeout(timer)
  }, [unsynced])

  const isStuck = unsynced && stuck
  const synced = !unsynced && justSynced
  const label = sending ? 'Syncing' : isStuck ? 'Not synced' : synced ? 'Synced' : unsynced ? 'Waiting to sync' : null
  const classes = ['score-slot']
  if (after) classes.push('score-slot--after')
  if (sending) classes.push('score-slot--sending')
  if (isStuck) classes.push('score-slot--stuck')
  if (synced) classes.push('score-slot--synced')
  return (
    <li>
      <Link
        to={PATH}
        params={{ matchId: match.id, gameNumber: String(game) }}
        search={true}
        className={classes.join(' ')}
        aria-current={current ? 'page' : undefined}
      >
        <span className="score-slot__label">Game {game}</span>{' '}
        <span className="score-slot__pts">{points ? <SlotScore points={points} sides={sides} /> : '–'}</span>
        {(sending || synced) && (
          <span className="score-slot__badge" aria-hidden="true">
            {!sending && <Icon name="check" />}
          </span>
        )}
        {label && <span className="score-slot__sync fm-sr">{label}</span>}
      </Link>
    </li>
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
  const feedbackId = useId()
  // In the match's player order, like the stored points.
  const [draft, setDraft] = useState<[string, string]>(
    saved ? [String(saved.points[0]), String(saved.points[1])] : ['', ''],
  )
  const inputs = useRef<[HTMLInputElement | null, HTMLInputElement | null]>([null, null])
  const entry = parseGameScore(draft[0], draft[1])
  const invalid = entry.kind === 'malformed' || entry.kind === 'illegal'

  function feedback(): ReactNode {
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
  }
  const message = feedback()

  // Saves on this device and moves on. The strip shows the game syncing.
  function save() {
    if (entry.kind !== 'legal' || !saveGame(match.id, gameNumber, entry.points, me)) return
    const after = slots.map((slot, index) => (index === gameNumber - 1 ? entry.points : slot))
    // Once the match is decided, the next empty game would only be an extra
    // one, so the page stays.
    if (deciderGame(after, match.bestOf) !== null) return
    const next = after.findIndex((slot, index) => index >= gameNumber && slot === null)
    if (next !== -1) {
      void navigate({ to: PATH, params: { matchId: match.id, gameNumber: String(next + 1) }, search: true })
    }
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
      {frozen ? (
        message
      ) : (
        <div className="score-actions">
          {/* The hint or the reason takes the place of "Saved by", in a line
              that keeps its height, so typing doesn't move the buttons. */}
          <div className="score-actions__note">
            {message ?? (saved && <span className="fm-help">Saved by {saved.savedBy.name}</span>)}
          </div>
          <div className="score-actions__buttons">
            {saved && (
              <Button variant="ghost" onClick={() => clearGame(match.id, gameNumber)}>
                Clear game
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={entry.kind !== 'legal'}>
              Save game {gameNumber}
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
  resultUnsynced,
  sync,
  viewer,
  slots,
  sides,
  me,
}: {
  match: Match
  submission: { phase: 'open' } | Submitted
  resultUnsynced: boolean
  sync: SyncStatus
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
        <p className="fm-help">
          {resultUnsynced
            ? sync.stuck
              ? 'Saved on this device. It reaches the server when you’re back online.'
              : 'Syncing the result…'
            : waitingFor && `Waiting for ${waitingFor.name}`}
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
