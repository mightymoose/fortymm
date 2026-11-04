import { createFileRoute } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../api/queries'
import { AwaitingValidation } from '../../../../../pages/matches/AwaitingValidation'
import { matchOf, scoringMatch } from '../../../../../scoring/matches'
import { readFragment } from '../../../../../scoring/fragment'

// The fragment is the signed result. Anything else gives a null fragment,
// which the page shows as an error.
export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/submission')({
  shouldReload: true,
  loader: {
    staleReloadMode: 'blocking',
    handler: async ({ context: { api, queryClient }, params, location }) => {
      const account = await queryClient.ensureQueryData(sessionQuery(api))
      const scoring = scoringMatch(params.matchId, location.hash)
      const match = matchOf(scoring, { id: account.player.id, name: account.player.display_name }, null)
      const fragment = readFragment(location.hash, match)
      return { scoring, fragment: fragment?.kind === 'signed' ? fragment : null }
    },
  },
  component: AwaitingValidation,
})
