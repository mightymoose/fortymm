import { useRouter } from '@tanstack/react-router'

import { ApiError } from '@/api/client'
import { AccessDenied } from '@/components/rbac/error-fallback'

export interface TournamentRouteErrorProps {
  error: Error
  reset: () => void
}

/**
 * Route-level fallback for the tournament detail route — **everything that is
 * genuinely an error**: 5xx, network-down, a malformed-draw parse failure, a
 * render throw, 401, and a 403.
 *
 * It does NOT own "Tournament not found". A 404 is not an error, it is a designed
 * state: the detail query's `queryFn` converts it into a router `notFound()`, and
 * the route's `notFoundComponent` (`TournamentNotFound`) renders it with copy that
 * names the missing thing and a link back to the tournaments list. A malformed id
 * never reaches here at all — `params.parse` throws `notFound()` before any fetch.
 * See `docs/adr/1001-a-missing-resource-is-a-not-found-not-an-error.md`.
 *
 * **Two branches, and the split is deliberate:**
 *
 * - **403** — a permitted non-creator the server still gates. This route used to
 *   have no error boundary of its own, so its 403 bubbled to the `RbacBoundary`
 *   the parent `tournaments` layout wraps the `<Outlet>` in, which renders
 *   `AccessDenied`. Now that the route owns its own boundary (for ADR-1001), that
 *   boundary catches the 403 first — so it renders the same `AccessDenied` panel,
 *   keeping the "you don't have access" UX exactly where it was. A 403 is a
 *   server-side refusal, not a transient failure, so it is not retryable.
 * - **everything else is retryable.** A 5xx, a dropped network, a bad payload, a
 *   render crash, a bare 401 — the tournament may well exist and the request
 *   simply failed, so the one action re-runs it.
 *
 * The `error` prop is typed `Error` because that is what TanStack hands an
 * `errorComponent`, but a `notFound()` is a plain object, not an `Error`; the
 * `instanceof ApiError` narrowing below tolerates a non-Error throw. (A
 * `notFound()` should never arrive here — `CatchNotFound` is mounted *inside*
 * `CatchBoundary`, so it catches first — but this is not the place to be surprised
 * by it.)
 *
 * The styling is the design system's page-level error state (`md-error-state`, in
 * `src/index.css`), the same treatment `AppError`, `MatchDetailsError` and
 * `PlayerRouteError` use.
 */
export function TournamentRouteError({ error, reset }: TournamentRouteErrorProps) {
  const router = useRouter()

  // A server-side permission gate — the same panel the parent `RbacBoundary` would
  // have shown, so direct-navigation to a tournament you can't see reads as
  // intentional rather than broken.
  if (error instanceof ApiError && error.status === 403) {
    return <AccessDenied />
  }

  return (
    <div role="alert" className="md-error-state" data-tone="alert">
      <div className="md-error-state__code">
        <span className="md-error-state__dot" aria-hidden="true" />
        Error
      </div>
      <h1 className="md-error-state__title">Couldn’t load this tournament.</h1>
      {/* Deliberately vague about the cause: this branch catches a 5xx, a dropped
       * network, a bad payload, a bare 401 and a render throw alike. Naming one
       * cause would be a confident lie in most of the others. Say what is true of
       * all of them — it didn't load, it may be temporary, here is the retry — and
       * let the button do the talking. The 404, the one status we CAN name, is not
       * here at all: it has its own page. */}
      <p className="md-error-state__sub">
        The tournament didn’t load. It may be temporary — try again.
      </p>
      <div className="md-error-state__actions">
        <button
          type="button"
          className="md-btn md-btn--primary"
          onClick={() => {
            // Reset the router's error boundary, then re-run the loaders so the
            // failed detail query refetches. Both halves matter: `reset()` alone
            // re-renders the boundary with the same failed query, and
            // `invalidate()` alone leaves the boundary up.
            reset()
            void router.invalidate()
          }}
        >
          Try again
        </button>
      </div>
    </div>
  )
}
