import { createFileRoute } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../api/queries'
import { AwaitingValidation } from '../../../../../pages/matches/AwaitingValidation'
import { demoMatch } from '../../../../../scoring/demoMatches'

export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/submission')({
  loader: async ({ context: { api, queryClient }, params }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    const match = demoMatch(params.matchId, { id: account.player.id, name: account.player.display_name })
    return { match, me: account.player.id }
  },
  component: AwaitingValidation,
})
