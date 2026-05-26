import { createFileRoute } from '@tanstack/react-router'
import { ScoreEntry } from '@/components/matches/score-entry'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute(
  '/matches/$matchId/games/$gameNumber/scores/edit',
)({
  head: () => ({
    meta: [{ title: pageTitle('Edit score') }],
  }),
  component: ScoreEditRoute,
})

function ScoreEditRoute() {
  const { matchId, gameNumber } = Route.useParams()
  return (
    <ScoreEntry
      matchId={matchId}
      gameNumber={Number(gameNumber)}
      mode={{ kind: 'edit' }}
    />
  )
}
