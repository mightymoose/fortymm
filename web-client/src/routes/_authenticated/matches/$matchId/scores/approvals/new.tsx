import { createFileRoute } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../../api/queries'
import { AcceptResult } from '../../../../../../pages/matches/AcceptResult'
import { matchOf, scoringMatch, syncsBoard } from '../../../../../../scoring/matches'
import { fragmentResult, readFragment } from '../../../../../../scoring/fragment'
import { signaturesHold } from '../../../../../../signing/verify'

// The fragment is the result to review. Anything but a signed result the
// match's scores could hold gives a null fragment, which the page shows as
// an error. `holds` says whether each signature matches the key its kid
// names, checked on the device, so a link whose bytes were changed is
// refused with no network. Whether a key is a player's is FortyMM's to
// check. Approving changes
// only the hash, so the loader runs again. `syncs` says whether this device
// sends the match's results.
export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/approvals/new')({
  shouldReload: true,
  loader: {
    staleReloadMode: 'blocking',
    handler: async ({ context: { api, queryClient }, params, location }) => {
      const account = await queryClient.ensureQueryData(sessionQuery(api))
      const scoring = scoringMatch(params.matchId, location.hash)
      const self = { id: account.player.id, name: account.player.display_name }
      const match = matchOf(scoring, self, fragmentResult(location.hash))
      const fragment = readFragment(location.hash, match)
      if (fragment?.kind !== 'signed') return { fragment: null, holds: false, match, syncs: false }
      return {
        fragment,
        holds: await signaturesHold(fragment.envelope),
        match,
        syncs: syncsBoard(match, account),
      }
    },
  },
  component: AcceptResult,
})
