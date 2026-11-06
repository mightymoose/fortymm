import { createFileRoute, redirect } from '@tanstack/react-router'
import { can, Permission } from '../../../../api/permissions'
import { matchQuery, sessionQuery } from '../../../../api/queries'
import { MatchPage } from '../../../../pages/matches/MatchPage'

// An account without `matches.view` goes to Home. The match starts loading
// here, as on the Matches page.
export const Route = createFileRoute('/_authenticated/_shell/matches/$matchId')({
  loader: async ({ params, context: { api, queryClient } }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    if (!can(account, Permission.matchesView)) throw redirect({ to: '/', replace: true })
    void queryClient.prefetchQuery(matchQuery(api, params.matchId))
  },
  component: MatchPage,
})
