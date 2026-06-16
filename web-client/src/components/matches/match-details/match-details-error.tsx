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
  // Mono eyebrow + Bebas headline + supporting copy, mirroring the design
  // system's page-level error/empty states ("Error and Empty States").
  const { code, message, detail } = notFound
    ? {
        code: '404 · Not found',
        message: "We couldn't find that match.",
        detail:
          "That match doesn't exist, or the link is wrong. It may have been deleted, or never finished being created.",
      }
    : rateLimited
      ? {
          code: 'Rate limited · 429',
          message: 'Too many requests. Try again shortly.',
          detail:
            "You're refreshing faster than we can keep up. Give it a moment, then try the same link again.",
        }
      : {
          code: 'Error',
          message: 'Something went wrong loading this match.',
          detail:
            "Our server didn't answer in time — could be us, could be the network. Try again in a moment.",
        }
  const body = (
    <div
      role="alert"
      className="md-error-state"
      data-tone={notFound ? 'neutral' : 'alert'}
    >
      <div className="md-error-state__code">
        <span className="md-error-state__dot" aria-hidden="true" />
        {code}
      </div>
      <h1 className="md-error-state__title">{message}</h1>
      <p className="md-error-state__sub">{detail}</p>
      <div className="md-error-state__actions">
        {notFound ? (
          <Link to="/matches" className="md-btn md-btn--primary">
            Back to matches
          </Link>
        ) : (
          <button
            type="button"
            className="md-btn md-btn--primary"
            onClick={() => {
              reset()
              router.invalidate()
            }}
          >
            Try again
          </button>
        )}
      </div>
    </div>
  )
  return <AppShell>{body}</AppShell>
}
