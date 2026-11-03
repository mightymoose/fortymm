import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { reviewBoard, winnerOf, type GamePoints, type Side, type Slots } from '../../scoring/board'
import type { Match } from '../../scoring/demoMatches'
import type { SyncStatus } from '../../scoring/sync'
import { PATH, type Sides } from './sides'

// How long a game's "Synced" mark shows once its change reaches the server.
const SYNCED_MS = 1200

// A link to each game, with its score and where its sync stands. Games
// after the decider step back.
export function GameStrip({
  match,
  slots,
  current,
  sides,
  unsynced,
  sync,
  canSubmit,
}: {
  match: Match
  slots: Slots
  current: number
  sides: Sides
  unsynced: Set<number>
  sync: SyncStatus
  canSubmit: boolean
}) {
  const review = reviewBoard(slots, match.bestOf)
  const decider = review.kind === 'undecided' ? null : review.decidedAtGame
  const sendingGame = sync.sending && 'game' in sync.sending.edit ? sync.sending.edit.game : null
  return (
    <nav
      className="score-strip-wrap"
      aria-label="Games"
      aria-busy={sync.sending !== null || sync.pulling || undefined}
    >
      {/* A line that keeps its height, so a note never moves the page. */}
      <div className="score-strip__head">
        <p className="score-strip__label">Games</p>
        {sync.stuck && unsynced.size > 0 ? (
          <p className="score-strip__note score-strip__note--waiting" role="status">
            {sync.stuck === 'offline' ? 'Offline. Saved on this device.' : 'Not synced yet. Saved on this device.'}
          </p>
        ) : (
          decider !== null &&
          decider < match.bestOf && (
            <p className="score-strip__note">
              Match decided after game {decider}
              {canSubmit &&
                review.kind === 'overrun' &&
                `. Clear ${review.extraGames.map((game) => `game ${game}`).join(' and ')} to submit.`}
            </p>
          )
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
            sending={sendingGame === index + 1}
            stuck={sync.stuck !== null}
          />
        ))}
      </ol>
    </nav>
  )
}

// One game, with where its last change stands: a dot while it's on its way
// to the server, a dashed amber edge while its sync is stuck, both while a
// stuck game tries again, and a moment of green once it lands. None of them
// changes the cell's size.
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
