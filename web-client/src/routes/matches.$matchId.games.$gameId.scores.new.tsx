import { createFileRoute } from '@tanstack/react-router'
import { ScoreEntry } from '@/components/matches/score-entry'
import { useCreateScore } from '@/api/matches'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute(
  '/matches/$matchId/games/$gameId/scores/new',
)({
  head: () => ({
    meta: [{ title: pageTitle('Enter score') }],
  }),
  component: ScoreCreateRoute,
})

function ScoreCreateRoute() {
  const { matchId, gameId } = Route.useParams()
  const mutation = useCreateScore(matchId, gameId)
  return (
    <ScoreEntry
      matchId={matchId}
      gameId={gameId}
      mode={{ kind: 'create' }}
      mutation={mutation}
    />
  )
}
