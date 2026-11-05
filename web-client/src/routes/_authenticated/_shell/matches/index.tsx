import { createFileRoute, redirect } from '@tanstack/react-router'
import { can, Permission } from '../../../../api/permissions'
import { sessionQuery } from '../../../../api/queries'
import { Matches } from '../../../../pages/matches/Matches'

// An account without `matches.view` goes to Home.
export const Route = createFileRoute('/_authenticated/_shell/matches/')({
  loader: async ({ context: { api, queryClient } }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    if (!can(account, Permission.matchesView)) throw redirect({ to: '/', replace: true })
  },
  component: Matches,
})
