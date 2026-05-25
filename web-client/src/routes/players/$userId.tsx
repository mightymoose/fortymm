import { useCallback } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

import { AppShell } from '@/components/app-shell'
import { PlayerProfile } from '@/components/players/player-profile'
import { findPlayerById } from '@/components/players/players-data'
import { pageTitle } from '@/lib/page-title'

// Matches list pagination lives in the URL so refresh / share / back works.
const profileSearchSchema = z.object({
  page: z.coerce.number().int().min(2).optional().catch(undefined),
})

export const Route = createFileRoute('/players/$userId')({
  head: () => ({
    meta: [{ title: pageTitle('Player') }],
  }),
  validateSearch: zodValidator(profileSearchSchema),
  component: PlayerRoute,
})

function PlayerRoute() {
  const { userId } = Route.useParams()
  const search = Route.useSearch()
  const page = search.page ?? 1
  const navigate = useNavigate()
  // Hardcoded fixture for now (see players-data.ts). Anything outside the
  // demo roster renders as "not found" — once we have the backend, this
  // route swaps to fetching by id.
  const player = findPlayerById(userId) ?? null

  const setPage = useCallback(
    (next: number) => {
      void navigate({
        to: '/players/$userId',
        params: { userId },
        replace: true,
        search: { page: next > 1 ? next : undefined },
      })
    },
    [navigate, userId],
  )

  return (
    <AppShell>
      {player ? (
        <PlayerProfile player={player} page={page} onPageChange={setPage} />
      ) : (
        <div className="p-6 text-sm text-[color:var(--loss)]">
          Player not found.
        </div>
      )}
    </AppShell>
  )
}
