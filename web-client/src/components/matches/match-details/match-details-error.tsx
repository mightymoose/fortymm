import { Link, useRouter } from '@tanstack/react-router'

import { AppShell } from '@/components/app-shell'
import { ApiError } from '@/api/client'

export interface MatchDetailsErrorProps {
  error: Error
  reset: () => void
}

/** Error boundary fallback for the match-details page. Translates the failing
 * `GET /v1/matches/{id}` status into the right message + recovery affordance. */
export function MatchDetailsError({ error, reset }: MatchDetailsErrorProps) {
  const router = useRouter()
  const status = error instanceof ApiError ? error.status : 0
  // `GET /v1/matches/{id}` is public and per-IP rate-limited, so a valid shared
  // URL can hit 429 under load/refresh bursts. That's transient — retrying the
  // same URL is exactly the right move, so treat it like a transient failure
  // (retry button) rather than the not-found dead end (#514).
  const rateLimited = status === 429
  // Any other client error (404 no-such-match, 422 malformed id, …) means
  // there's no viewable match at this URL — show the friendly copy and never
  // leak the raw API detail (e.g. the pydantic "Input should be a valid UUID"
  // string, #152). Retrying won't help, so offer a way back to the list.
  const notFound = !rateLimited && status >= 400 && status < 500
  const message = notFound
    ? "We couldn't find that match."
    : rateLimited
      ? 'Too many requests. Try again shortly.'
      : 'Something went wrong loading this match.'
  const body = (
    <div role="alert" className="md-error-state">
      <div className="md-error-state__title">{message}</div>
      {notFound ? (
        <Link to="/matches" className="md-btn md-btn--secondary">
          Back to matches
        </Link>
      ) : (
        <button
          type="button"
          className="md-btn md-btn--secondary"
          onClick={() => {
            reset()
            router.invalidate()
          }}
        >
          Try again
        </button>
      )}
    </div>
  )
  return <AppShell>{body}</AppShell>
}
