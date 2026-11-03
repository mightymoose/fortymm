import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLoaderData, useLocation, useParams, useRouteContext } from '@tanstack/react-router'
import { sessionQuery } from '../../api/queries'
import { Icon } from '../../components/Icon'
import { Wordmark } from '../../components/Wordmark'
import { demoMatch, matchFor, viewerOf, type Match, type Viewer } from '../../scoring/demoMatches'
import { gamesOf, type Fragment } from '../../scoring/fragment'
import { slotsOf } from '../../scoring/planPress'
import { GameStrip } from './GameStrip'
import { ResultPanel } from './ResultPanel'
import { ScoreEntry } from './ScoreEntry'
import { midSentence, playerLabel, ROUTE, sidesFor } from './sides'
import './scoring.css'

// One match's scores, open at one game. The URL's fragment holds every
// game, so the URL is the only state: a reload shows the same games, a
// shared URL opens them on another device, and two tabs don't share edits.
// Anyone who can open the match can enter or change a game, as long as its
// score is legal. The match rules apply only when a player submits.
export function ScoreGame() {
  const { matchId } = useParams({ from: ROUTE })
  const { fragment, gameNumber, last } = useLoaderData({ from: ROUTE })
  const { hash, state } = useLocation()
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const self = { id: account.player.id, name: account.player.display_name }
  // The route checked the result is this match's, so matchFor() finds it.
  const match = matchFor(matchId, self, fragment.kind === 'empty' ? null : fragment.result) ?? demoMatch(matchId, self)
  const games = gamesOf(fragment)
  const viewer = viewerOf(match, self.id)
  const sides = sidesFor(viewer.role === 'player' ? viewer.side : 0)
  const saved = games[gameNumber - 1]
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
        />
        <GameStrip
          match={match}
          slots={slotsOf(games, match.bestOf)}
          current={gameNumber}
          reachable={last}
          hash={hash}
          sides={sides}
          canSubmit={viewer.role === 'player'}
        />
        <ResultPanel match={match} viewer={viewer} />
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
