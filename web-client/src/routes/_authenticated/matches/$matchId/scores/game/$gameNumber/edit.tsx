import { createFileRoute, redirect } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../../../api/queries'
import { ScoreGame } from '../../../../../../../pages/scoring/ScoreGame'
import { demoMatch } from '../../../../../../../scoring/demoMatches'

// A game number that isn't one of the match's games goes to game 1.
export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/game/$gameNumber/edit')({
  loader: async ({ context: { api, queryClient }, params }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    const match = demoMatch(params.matchId, { id: account.player.id, name: account.player.display_name })
    const gameNumber = Number(params.gameNumber)
    if (!/^[1-9][0-9]*$/.test(params.gameNumber) || gameNumber > match.bestOf) {
      throw redirect({
        to: '/matches/$matchId/scores/game/$gameNumber/edit',
        params: { matchId: params.matchId, gameNumber: '1' },
        replace: true,
      })
    }
    return { match, gameNumber }
  },
  component: ScoreGame,
})
