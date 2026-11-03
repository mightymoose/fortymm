import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLoaderData, useParams, useRouteContext } from '@tanstack/react-router'
import { sessionQuery } from '../../api/queries'
import { Icon } from '../../components/Icon'
import { Wordmark } from '../../components/Wordmark'
import { demoMatch, viewerOf } from '../../scoring/demoMatches'
import { slotsOf, useScratchpad, type Scorer } from '../../scoring/scratchpad'
import { useSync } from '../../scoring/sync'
import { GameStrip } from './GameStrip'
import { ResultPanel } from './ResultPanel'
import { ScoreEntry } from './ScoreEntry'
import { ROUTE, sidesFor } from './sides'
import { TestingPanel } from './TestingPanel'
import './scoring.css'

// The scratchpad of one match, open at one game. Anyone who can open the
// match can enter or change any game, in any order, as long as each game's
// score is legal. The match rules apply only when a player submits. The
// board comes from this device and syncs in the background, so the page has
// no loading or error state of its own.
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

function ScoreBoard({ gameNumber }: { gameNumber: number }) {
  const { matchId } = useParams({ from: ROUTE })
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const me: Scorer = { playerId: account.player.id, name: account.player.display_name }
  const match = demoMatch(matchId, { id: me.playerId, name: me.name })
  const sync = useSync(match.id)
  const viewer = viewerOf(match, me.playerId)
  const pad = useScratchpad(match.id)
  const sides = sidesFor(viewer.role === 'player' ? viewer.side : 0)
  const saved = pad.games[gameNumber]
  const edits = pad.outbox.map((change) => change.edit)

  return (
    <>
      <ScoreEntry
        // A new game, or a score from another tab, starts the entry over.
        key={`${gameNumber}:${saved?.points.join('-') ?? ''}`}
        match={match}
        gameNumber={gameNumber}
        board={pad}
        viewer={viewer}
        sides={sides}
        me={me}
      />
      <GameStrip
        match={match}
        slots={slotsOf(pad, match.bestOf)}
        current={gameNumber}
        sides={sides}
        unsynced={new Set(edits.flatMap((edit) => ('game' in edit ? [edit.game] : [])))}
        sync={sync}
        canSubmit={viewer.role === 'player' && pad.submission.phase === 'open'}
      />
      <ResultPanel
        match={match}
        submission={pad.submission}
        resultUnsynced={edits.some((edit) => edit.kind === 'submit' || edit.kind === 'reopen')}
        stuck={sync.stuck !== null}
        viewer={viewer}
        me={me}
      />
    </>
  )
}
