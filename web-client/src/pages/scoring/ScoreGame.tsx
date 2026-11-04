import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLoaderData, useLocation, useParams, useRouteContext, useRouter } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'
import { sessionQuery } from '../../api/queries'
import { Icon } from '../../components/Icon'
import { Wordmark } from '../../components/Wordmark'
import { viewerOf, type Match, type Viewer } from '../../scoring/demoMatches'
import { matchOf } from '../../scoring/matches'
import { adopts, boardsOf, learnBoard, subscribeBoards, unsyncedGames } from '../../scoring/boards'
import { gamesOf, readFragment, type Fragment } from '../../scoring/fragment'
import { slotsOf } from '../../scoring/planPress'
import { useBoardSync } from '../../scoring/sync'
import { GameStrip } from './GameStrip'
import { ResultPanel } from './ResultPanel'
import { ScoreEntry } from './ScoreEntry'
import { useSubmitResult } from './useSubmitResult'
import { midSentence, PATH, playerLabel, ROUTE, sidesFor } from './sides'
import { TestingPanel } from './TestingPanel'
import './scoring.css'

// One match's scores, open at one game. The URL's fragment holds every
// game, so the URL is the scorer's truth: a reload shows the same games,
// and a shared URL opens them on another device. Each save also syncs the
// board in the background, and the page follows the server's board while
// it has nothing to send, so spectators and tournament directors can watch.
// Anyone who can open the match can enter or change a game, as long as its
// score is legal. The match rules apply only when a player submits.
export function ScoreGame() {
  const { matchId } = useParams({ from: ROUTE })
  const { scoring, fragment, gameNumber, last } = useLoaderData({ from: ROUTE })
  const { hash, state } = useLocation()
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const self = { id: account.player.id, name: account.player.display_name }
  const match = matchOf(scoring, self, fragment.kind === 'empty' ? null : fragment.result)
  const games = gamesOf(fragment)
  const viewer = viewerOf(match, self.id)
  const sides = sidesFor(viewer.role === 'player' ? viewer.side : 0)
  const saved = games[gameNumber - 1]
  const router = useRouter()
  const sync = useBoardSync(match.id, (text) => {
    const pulled = readFragment(text, match)
    if (!pulled) return
    const { synced } = boardsOf(match.id)
    learnBoard(match.id, text)
    const shownText = router.state.location.hash
    const shown = readFragment(shownText, match) ?? { kind: 'empty' }
    if (!adopts({ text: shownText, fragment: shown }, { text, fragment: pulled }, synced)) return
    const reachable = Math.min(gamesOf(pulled).length + 1, match.bestOf)
    void router.navigate({
      to: PATH,
      params: { matchId, gameNumber: String(Math.min(gameNumber, reachable)) },
      search: true,
      hash: text,
      replace: true,
    })
  })
  const boards = useSyncExternalStore(subscribeBoards, () => boardsOf(match.id))
  // Only a board waiting to go marks games, so a board from a link that
  // nobody saved here doesn't read as stuck.
  const submit = useSubmitResult(match, fragment)
  const unsynced =
    boards.pending === null
      ? new Set<number>()
      : unsyncedGames(games, gamesOf(readFragment(boards.synced ?? '', match) ?? { kind: 'empty' }))
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
        {state.discardedScores && (
          <p className="fm-notice">
            <Icon name="info" />
            <span>This link’s scores couldn’t be read, so the scores start empty.</span>
          </p>
        )}
        <FragmentNotice fragment={fragment} match={match} viewer={viewer} />
        <ScoreEntry
          // A new game, or a new score for it, starts the entry over.
          key={`${gameNumber}:${saved?.join('-') ?? ''}`}
          match={match}
          gameNumber={gameNumber}
          fragment={fragment}
          viewer={viewer}
          sides={sides}
          submit={submit}
        />
        <GameStrip
          match={match}
          slots={slotsOf(games, match.bestOf)}
          current={gameNumber}
          reachable={last}
          hash={hash}
          sides={sides}
          canSubmit={viewer.role === 'player'}
          unsynced={unsynced}
          sync={sync}
        />
        <ResultPanel match={match} viewer={viewer} />
        <TestingPanel match={match} />
      </main>
    </div>
  )
}

// What the scores on screen correct. The page never says "sign": to a
// player, signing is approving.
function FragmentNotice({ fragment, match, viewer }: { fragment: Fragment; match: Match; viewer: Viewer }) {
  const text = (() => {
    switch (fragment.kind) {
      case 'empty':
        return null
      case 'draft':
        return fragment.result.replaces && 'This corrects an earlier result.'
      case 'signed': {
        const by = new Set(fragment.signers)
        const who =
          by.size === 2
            ? 'Approved by both players'
            : `Reported by ${midSentence(playerLabel(match, viewer, match.players[fragment.signers[0]].id))}`
        return `${who}. A change makes a new result that corrects it.`
      }
    }
  })()
  if (!text) return null
  return (
    <p className="fm-notice">
      <Icon name="info" />
      <span>{text}</span>
    </p>
  )
}
