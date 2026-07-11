import { useRouter } from '@tanstack/react-router'

import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'

/**
 * Route-level fallback for `throwOnError` player-profile fetch failures.
 * 4xx → "Player not found" (no point retrying the same id); 5xx → "Try again".
 *
 * Shared by the profile route and its match-history sub-route — both hang off
 * the same `playerByIdQueryOptions` query, so they fail the same way.
 */
export function PlayerRouteError({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}) {
  const router = useRouter()
  // `ApiError` is what `unwrap` throws for non-2xx responses, and it carries the
  // status — so narrow on the class rather than duck-typing a `status` off an
  // `unknown` shape. Anything else that reaches this boundary (a render error, a
  // network throw) has no status, and gets the retryable branch.
  //
  // Treat 4xx as "no such player": retrying the same id would fail the same way.
  const status = error instanceof ApiError ? error.status : 0
  const notFound = status >= 400 && status < 500
  return (
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
  )
}
