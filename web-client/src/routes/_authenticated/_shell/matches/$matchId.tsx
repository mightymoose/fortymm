import { createFileRoute, redirect } from '@tanstack/react-router'
import { can, Permission } from '../../../../api/permissions'
import { sessionQuery } from '../../../../api/queries'
import { parseVariant } from '../../../../pages/matches/browse/variants'
import { MatchPage } from '../../../../pages/matches/MatchPage'

// An account without `matches.view` goes to Home.
export const Route = createFileRoute('/_authenticated/_shell/matches/$matchId')({
  validateSearch: parseVariant,
  loader: async ({ context: { api, queryClient } }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    if (!can(account, Permission.matchesView)) throw redirect({ to: '/', replace: true })
  },
  component: MatchPage,
})
