import { useRouter } from '@tanstack/react-router'

export interface PlayerRouteErrorProps {
  error: Error
  reset: () => void
}

/**
 * Route-level fallback for player-profile fetch failures — **everything that is
 * genuinely an error**: 5xx, network-down, a decode failure, a render throw,
 * 401, 403.
 *
 * It no longer owns "Player not found". A 404 is not an error, it is a designed
 * state: the profile bundle's `queryFn` converts it into a router `notFound()`,
 * and the routes' `notFoundComponent` (`PlayerNotFound`) renders it with copy
 * that names the missing thing and a link back to the players list. See
 * `docs/adr/1001-a-missing-resource-is-a-not-found-not-an-error.md`.
 *
 * So this boundary has **one branch, and it is always retryable**. That is the
 * point of the split, and it is deliberate for the two statuses that are still
 * 4xx and still land here:
 *
 * - **401.** A *session-ended* 401 never reaches a boundary at all — the API
 *   client's global handler (`setSessionEndedHandler`, wired in `main.tsx`)
 *   catches it and routes to `/login`. A bare 401 is an ordinary auth failure,
 *   which a retry after the session settles can genuinely clear.
 * - **403.** Effectively unreachable on a `GET /v1/players/{id}` (the endpoint is
 *   authenticated, not authorized per-player; CSRF 403s only mutating requests) —
 *   but if one ever appears it is a *server-side* refusal, not a missing player.
 *
 * Neither may be told "Player not found.", and neither may be left without a way
 * out — that dead end (the old `{!notFound && …}`) is exactly the bug #1001 filed.
 * The test file pins both statuses explicitly, because with a single branch that
 * correctness otherwise holds only *by construction*: nothing would catch a future
 * change that reintroduced branching and stranded a 401 in an actionless dead end
 * again.
 *
 * **The styling is the design system's page-level error state (`md-error-state`),
 * not the match list's.** This markup used to reach for `.empty` / `.empty-title`
 * / `.empty-sub` / `.empty-clear`, which are defined *only* under a
 * `.match-list-page` ancestor (`components/matches/match-list/match-list.css`).
 * The profile route has no such ancestor, so every one of those class names
 * matched nothing and the error state painted as naked, unpadded text jammed
 * against the sidebar — the *same* paint bug #1001 filed, on the half that is not
 * a 404. `md-error-state` is declared in `src/index.css` under `.fortymm-theme`,
 * which is on `<body>`, so it applies anywhere in the app; it is the treatment
 * `AppError` and `MatchDetailsError` (the boundary reference implementation)
 * already use, and it is the same "Error and Empty States" language as the
 * not-found page beside it — mono eyebrow, display headline, one sentence, one
 * action. `data-tone="alert"` is what tints the headline for an error rather than
 * the neutral not-found.
 *
 * The `error` prop is typed `Error` because that is what TanStack hands an
 * `errorComponent`, but nothing here dereferences it: a `notFound()` is a plain
 * object, not an `Error`, so anything on this path must tolerate a non-Error
 * throw. (It should never arrive here — `CatchNotFound` is mounted *inside*
 * `CatchBoundary`, so it catches first — but this component is not the place to
 * be surprised by it.)
 *
 * Shared by the profile route and its match-history sub-route: both hang off the
 * same `playerByIdQueryOptions` query, so they fail the same way.
 */
export function PlayerRouteError({ reset }: PlayerRouteErrorProps) {
  const router = useRouter()
  return (
    <div role="alert" className="md-error-state" data-tone="alert">
      <div className="md-error-state__code">
        <span className="md-error-state__dot" aria-hidden="true" />
        Error
      </div>
      <h1 className="md-error-state__title">Couldn’t load this player.</h1>
      {/* Deliberately vague about the cause, because this one branch catches
       * everything that is not a 404: a 5xx, a dropped network, a 401, a 403,
       * and a render throw inside any profile card. Naming a cause — "reaching
       * the server", "the network" — would be a confident lie in most of those,
       * and "try again in a moment" promises a fix that a deterministic render
       * crash or a real auth failure will never deliver. Say what is true of all
       * of them (it didn't load, it may be temporary, here is the retry) and let
       * the button do the talking. The 404 — the one status we CAN name — is not
       * here at all any more; it has its own page. */}
      <p className="md-error-state__sub">
        The profile didn’t load. It may be temporary — try again.
      </p>
      <div className="md-error-state__actions">
        <button
          type="button"
          className="md-btn md-btn--primary"
          onClick={() => {
            // Reset the router's error boundary, then re-run the loaders so the
            // failed profile bundle refetches. Both halves matter: `reset()`
            // alone re-renders the boundary with the same failed query, and
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
