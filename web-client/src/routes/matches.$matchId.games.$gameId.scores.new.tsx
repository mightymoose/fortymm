import { createFileRoute } from '@tanstack/react-router'
import { ScoreEntry } from '@/components/matches/score-entry'
import { useCreateScore } from '@/api/matches'

export const Route = createFileRoute(
  '/matches/$matchId/games/$gameId/scores/new',
)({
  head: () => ({
    meta: [{ title: 'Enter score · FortyMM' }],
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
