import { createFileRoute, redirect } from '@tanstack/react-router'
import { can, Permission } from '../../../../api/permissions'
import { sessionQuery } from '../../../../api/queries'
import { Players } from '../../../../pages/players/Players'

// An account without `players.view` goes to Home.
export const Route = createFileRoute('/_authenticated/_shell/players/')({
  loader: async ({ context: { api, queryClient } }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    if (!can(account, Permission.playersView)) throw redirect({ to: '/', replace: true })
  },
  component: Players,
})
