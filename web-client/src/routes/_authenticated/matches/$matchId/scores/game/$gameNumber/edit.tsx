import { createFileRoute, redirect } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../../../api/queries'
import { ScoreGame } from '../../../../../../../pages/scoring/ScoreGame'
import { demoMatch } from '../../../../../../../scoring/demoMatches'
import { parseNetwork, type Network } from '../../../../../../../scoring/demoServer'

// A game number that isn't one of the match's games goes to game 1. The page
// loads the match itself, through the network that `network` names.
export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/game/$gameNumber/edit')({
  validateSearch: (search: Record<string, unknown>): { network?: Network } =>
    search.network === undefined ? {} : { network: parseNetwork(search.network) },
  loader: async ({ context: { api, queryClient }, params }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    const match = demoMatch(params.matchId, { id: account.player.id, name: account.player.display_name })
    const gameNumber = Number(params.gameNumber)
    if (!/^[1-9][0-9]*$/.test(params.gameNumber) || gameNumber > match.bestOf) {
      throw redirect({
        to: '/matches/$matchId/scores/game/$gameNumber/edit',
        params: { matchId: params.matchId, gameNumber: '1' },
        search: true,
        replace: true,
      })
    }
    return { gameNumber }
  },
  component: ScoreGame,
})
