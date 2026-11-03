import { createFileRoute } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../../api/queries'
import { AcceptResult } from '../../../../../../pages/matches/AcceptResult'
import { demoMatch } from '../../../../../../scoring/demoMatches'
import { readFragment } from '../../../../../../scoring/fragment'

// The fragment is the result to review. Anything but a signed result the
// match's scores could hold gives a null fragment, which the page shows as
// an error. Approving changes only the hash, so the loader runs again.
export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/approvals/new')({
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
  component: AcceptResult,
})
