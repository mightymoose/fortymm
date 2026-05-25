import { useCallback } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

import { PlayerProfile } from '@/components/players/player-profile'
import { findPlayerByName } from '@/components/players/players-data'
import { pageTitle } from '@/lib/page-title'

const profileSearchSchema = z.object({
  page: z.coerce.number().int().min(2).optional().catch(undefined),
})

export const Route = createFileRoute('/p/users/$username')({
  head: () => ({
    meta: [{ title: pageTitle('User') }],
  }),
  validateSearch: zodValidator(profileSearchSchema),
  component: PublicUserRoute,
})

function PublicUserRoute() {
  const { username } = Route.useParams()
  const search = Route.useSearch()
  const page = search.page ?? 1
  const navigate = useNavigate()
  // Hardcoded fixture for now — the design's "name" doubles as the URL slug
  // here (e.g. /p/users/Thanh%20Nguyen). Will swap to real username lookup
  // once the backend is wired.
  const player = findPlayerByName(username) ?? null

  const setPage = useCallback(
    (next: number) => {
      void navigate({
        to: '/p/users/$username',
        params: { username },
        replace: true,
        search: { page: next > 1 ? next : undefined },
      })
    },
    [navigate, username],
  )

  if (!player) {
    return (
      <div className="p-6 text-sm text-[color:var(--loss)]">User not found.</div>
    )
  }
  return (
    <PlayerProfile
      player={player}
      page={page}
      onPageChange={setPage}
      // Public route: match-detail links would 401 for anonymous viewers.
      matchesAreLinks={false}
    />
  )
}
