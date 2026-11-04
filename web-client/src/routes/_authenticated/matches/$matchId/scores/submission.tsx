import { createFileRoute } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../api/queries'
import { AwaitingValidation } from '../../../../../pages/matches/AwaitingValidation'
import { demoMatch } from '../../../../../scoring/demoMatches'
import { readFragment } from '../../../../../scoring/fragment'

// The fragment is the signed result. Anything else gives a null fragment,
// which the page shows as an error.
export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/submission')({
  shouldReload: true,
  loader: {
    staleReloadMode: 'blocking',
    handler: async ({ context: { api, queryClient }, params, location }) => {
      const account = await queryClient.ensureQueryData(sessionQuery(api))
      const match = demoMatch(params.matchId, { id: account.player.id, name: account.player.display_name })
      const fragment = readFragment(location.hash, match)
      return { fragment: fragment?.kind === 'signed' ? fragment : null }
    },
  },
  component: AwaitingValidation,
})
