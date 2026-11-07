import { createFileRoute } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../../api/queries'
import { AcceptResult } from '../../../../../../pages/matches/AcceptResult'
import { matchOf, scoringMatch, syncsBoard } from '../../../../../../scoring/matches'
import { readFragment } from '../../../../../../scoring/fragment'

// The fragment is the result to review. Anything but a signed result the
// match's scores could hold gives a null fragment, which the page shows as
// an error. Approving changes only the hash, so the loader runs again.
// `syncs` says whether this device sends the match's results.
export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/approvals/new')({
  shouldReload: true,
  loader: {
    staleReloadMode: 'blocking',
    handler: async ({ context: { api, queryClient }, params, location }) => {
      const account = await queryClient.ensureQueryData(sessionQuery(api))
      const scoring = scoringMatch(params.matchId, location.hash)
      const match = matchOf(scoring, { id: account.player.id, name: account.player.display_name }, null)
      const fragment = readFragment(location.hash, match)
      return { fragment: fragment?.kind === 'signed' ? fragment : null, syncs: syncsBoard(match, account) }
    },
  },
  component: AcceptResult,
})
