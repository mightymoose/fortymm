import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import { Scoring } from '../../../../../../components/Scoring.tsx'
import { gameToOpen } from '../../../../../../scoring/game-to-open.ts'
import { matchStore } from '../../../../../../stores/match.ts'

// The scoring screen for game $gameId (the game number, 1 to best of) of a
// match. There is no route at /games/$gameId or /scores: those are not found.
// Which game opens is gameToOpen's to decide (scoring/game-to-open.ts); this
// loader turns its answer into the router's: not found, or, for an empty game
// of a decided match, a redirect to the dashboard. Any other game opens, in
// any order.
export const Route = createFileRoute('/matches/$matchId/games/$gameId/scores/edit')({
  // A route's loader runs alongside its parent's, so this one reads the match
  // itself (the store queues the reads) rather than wait for the layout's.
  // A match that isn't there is the layout's not found.
  loader: async ({ params: { matchId, gameId } }) => {
    const entry = await matchStore.getState().load(matchId)
    if (entry.status !== 'ready') return
    const opened = gameToOpen(gameId, entry.match)
    if (opened.status === 'not-found') throw notFound()
    if (opened.status === 'decided') throw redirect({ to: '/', replace: true })
  },
  component: ScoringRoute,
})

function ScoringRoute() {
  const { matchId, gameId } = Route.useParams()
  return <Scoring matchId={matchId} game={Number(gameId)} />
}
