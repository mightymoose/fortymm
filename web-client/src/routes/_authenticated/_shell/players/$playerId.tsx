import { createFileRoute, redirect } from '@tanstack/react-router'
import { can, Permission } from '../../../../api/permissions'
import { sessionQuery } from '../../../../api/queries'
import { PlayerPage } from '../../../../pages/players/Player'
import { parseVariant, type Variant } from '../../../../pages/players/variant'

// An account without `players.view` goes to Home.
export const Route = createFileRoute('/_authenticated/_shell/players/$playerId')({
  validateSearch: (search: Record<string, unknown>): { variant?: Variant } => ({
    variant: parseVariant(search.variant),
  }),
  loader: async ({ context: { api, queryClient } }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    if (!can(account, Permission.playersView)) throw redirect({ to: '/', replace: true })
  },
  component: PlayerPage,
})
