import { createFileRoute, redirect } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../../../api/queries'
import { ScoreGame } from '../../../../../../../pages/scoring/ScoreGame'
import { demoMatch } from '../../../../../../../scoring/demoMatches'
import { parseNetwork, type Network } from '../../../../../../../scoring/demoServer'

// A game number that isn't one of the match's games goes to game 1. The
// match comes with the route, so the page draws at once, with or without a
// connection, and pulls the server's board in the background.
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
    return { match, gameNumber }
  },
  component: ScoreGame,
})
