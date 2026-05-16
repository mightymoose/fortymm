import { createFileRoute } from '@tanstack/react-router'
import { ScoreEntry } from '@/components/matches/score-entry'
import { useUpdateScore } from '@/api/matches'

export const Route = createFileRoute(
  '/matches/$matchId/games/$gameId/scores/$scoreId/edit',
)({
  head: () => ({
    meta: [{ title: 'Edit score · FortyMM' }],
  }),
  component: ScoreEditRoute,
})

function ScoreEditRoute() {
  const { matchId, gameId, scoreId } = Route.useParams()
  const mutation = useUpdateScore(matchId, gameId, scoreId)
  return (
    <ScoreEntry
      matchId={matchId}
      gameId={gameId}
      mode={{ kind: 'edit', scoreId }}
      mutation={mutation}
    />
  )
}
