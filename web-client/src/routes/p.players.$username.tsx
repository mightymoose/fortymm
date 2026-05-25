import { useCallback } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

import { usePublicPlayerByUsername } from '@/api/players'
import { PlayerProfile } from '@/components/players/player-profile'
import { Button } from '@/components/ui/button'
import { pageTitle } from '@/lib/page-title'

const profileSearchSchema = z.object({
  page: z.coerce.number().int().min(2).optional().catch(undefined),
})

export const Route = createFileRoute('/p/players/$username')({
  head: () => ({
    meta: [{ title: pageTitle('Player') }],
  }),
  validateSearch: zodValidator(profileSearchSchema),
  component: PublicPlayerRoute,
  errorComponent: PublicPlayerError,
})

function PublicPlayerRoute() {
  const { username } = Route.useParams()
  const search = Route.useSearch()
  const page = search.page ?? 1
  const navigate = useNavigate()

  // Public route — no session required; `throwOnError` flows non-2xx into
  // `errorComponent` above.
  const { data: player, isPending } = usePublicPlayerByUsername(username)

  const setPage = useCallback(
    (next: number) => {
      void navigate({
        to: '/p/players/$username',
        params: { username },
        replace: true,
        search: { page: next > 1 ? next : undefined },
      })
    },
    [navigate, username],
  )

  return (
    <PlayerProfile
      player={player ?? null}
      isPending={isPending}
      page={page}
      onPageChange={setPage}
      // Public route: match-detail links would 401 for anonymous viewers.
      matchesAreLinks={false}
      // No AppShell on this route, so the layout shouldn't subtract a topbar.
      standalone
    />
  )
}

function PublicPlayerError({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}) {
  const router = useRouter()
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status: number }).status
      : 0
  const notFound = status >= 400 && status < 500
  return (
    <div
      role="alert"
      style={{
        minHeight: '100vh',
        background: 'var(--bg-app)',
        color: 'var(--fg-1)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px',
        textAlign: 'center',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg-2)' }}>
        {notFound ? 'Player not found.' : 'Couldn’t load this player.'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>
        {notFound
          ? 'The URL might be off, or this player has been removed.'
          : 'Something went wrong reaching the server.'}
      </div>
      {!notFound && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            reset()
            router.invalidate()
          }}
        >
          Try again
        </Button>
      )}
    </div>
  )
}
