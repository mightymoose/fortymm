import { useCallback } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

import { usePlayerById } from '@/api/players'
import { useSession } from '@/api/session'
import { AppShell } from '@/components/app-shell'
import { PlayerProfile } from '@/components/players/player-profile'
import { Button } from '@/components/ui/button'
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
  errorComponent: PlayerRouteError,
})

function PlayerRoute() {
  const { userId } = Route.useParams()
  const search = Route.useSearch()
  const page = search.page ?? 1
  const navigate = useNavigate()

  // Gate on the session so a first-visit direct-load doesn't race the
  // session cookie. Profile query is `throwOnError`, so any non-2xx /
  // network failure flows to `errorComponent` above.
  const session = useSession()
  const { data: player, isPending } = usePlayerById(userId, {
    enabled: session.isSuccess,
  })

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
      <PlayerProfile
        player={player ?? null}
        isPending={isPending}
        page={page}
        onPageChange={setPage}
      />
    </AppShell>
  )
}

/** Route-level fallback for `throwOnError` profile-fetch failures. 4xx →
 * "Player not found" (no point retrying the same id); 5xx → "Try again". */
function PlayerRouteError({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}) {
  const router = useRouter()
  // ApiError is what `unwrap` throws for non-2xx responses; treat 4xx as
  // "no such player" and avoid offering a retry that will fail the same way.
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status: number }).status
      : 0
  const notFound = status >= 400 && status < 500
  return (
    <AppShell>
      <div role="alert" className="empty">
        <div className="empty-title">
          {notFound ? 'Player not found.' : 'Couldn’t load this player.'}
        </div>
        <div className="empty-sub">
          {notFound
            ? 'The URL might be off, or this player has been removed.'
            : 'Something went wrong reaching the server.'}
        </div>
        {!notFound && (
          <Button
            variant="ghost"
            size="sm"
            className="empty-clear"
            onClick={() => {
              reset()
              router.invalidate()
            }}
          >
            Try again
          </Button>
        )}
      </div>
    </AppShell>
  )
}
