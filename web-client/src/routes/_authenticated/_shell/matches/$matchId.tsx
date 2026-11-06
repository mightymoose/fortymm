import { createFileRoute, redirect } from '@tanstack/react-router'
import { can, Permission } from '../../../../api/permissions'
import { sessionQuery } from '../../../../api/queries'
import { matchQuery } from '../../../../pages/matches/browse/matchQueries'
import { MatchPage } from '../../../../pages/matches/MatchPage'

// An account without `matches.view` goes to Home. The match starts loading
// here, as on the Matches page.
export const Route = createFileRoute('/_authenticated/_shell/matches/$matchId')({
  loader: async ({ params, context: { api, queryClient } }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    if (!can(account, Permission.matchesView)) throw redirect({ to: '/', replace: true })
    void queryClient.prefetchQuery(matchQuery(params.matchId))
  },
  component: MatchPage,
})
