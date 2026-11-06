import { createFileRoute, redirect } from '@tanstack/react-router'
import { can, Permission } from '../../../../api/permissions'
import { sessionQuery } from '../../../../api/queries'
import { matchesQuery } from '../../../../pages/matches/browse/matchQueries'
import { Matches } from '../../../../pages/matches/Matches'

// An account without `matches.view` goes to Home. The list starts loading
// here, so a link's preload has it ready, but the page doesn't wait for it:
// its own boundary shows the skeleton.
export const Route = createFileRoute('/_authenticated/_shell/matches/')({
  loader: async ({ context: { api, queryClient } }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    if (!can(account, Permission.matchesView)) throw redirect({ to: '/', replace: true })
    void queryClient.prefetchQuery(matchesQuery())
  },
  component: Matches,
})
