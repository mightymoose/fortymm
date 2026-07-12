# 1001. A missing resource is a not-found, not an error

Date: 2026-07-12

## Status

Accepted

Numbered off the driving issue (#1001), following the `0915-*` ADRs, rather than
by incrementing the highest file on disk — that scheme has already produced two
`0016`s and four `0008`s, because parallel worktrees each number off a stale main.

## Context

`DEFINITION_OF_COMPLETE.md` has said this since it was written:

> loaders throw `notFound()` for missing/tombstoned resources on direct detail
> URLs → `notFoundComponent`

Nothing in the web client has ever done it. Before this change, **`notFound()` was
called exactly zero times in the entire codebase.** A designed 404 page exists —
`NotFoundPage`, wired as `defaultNotFoundComponent` in `main.tsx` — but the only
thing that could ever reach it was a URL matching **no route at all**. A URL that
matched a route perfectly and merely named a resource that does not exist took a
completely different path: the query 404s, `throwOnError` turns that into an
`ApiError`, and it lands in the route's **`errorComponent`**.

Each detail route then hand-rolled its own not-found *inside its error boundary*.
The player profile's looked like this:

```tsx
const notFound = status >= 400 && status < 500
return (
  <div role="alert" className="empty">
    <div className="empty-title">
      {notFound ? 'Player not found.' : 'Couldn’t load this player.'}
    </div>
    …
    {!notFound && <Button …>Try again</Button>}
  </div>
)
```

Two things followed from that, and QA filed both (#1001):

- **It rendered as naked text.** The `.empty` / `.empty-title` / `.empty-sub`
  classes it reaches for are defined **only** under a `.match-list-page` ancestor.
  On the profile route there is no such ancestor, so every class matched nothing:
  two unpadded lines jammed against the sidebar border.
- **It was a dead end.** Note the `{!notFound && …}` — the 404 branch is the *only*
  branch with no action at all. Enumerating the links and buttons in `main`
  returned `[]`. The only escape was the browser's back button.

The paint could have been fixed in ten minutes. The reason it is worth an ADR is
that the *taxonomy* is what generated both bugs, and the taxonomy is repo-wide:
tournaments hand-rolls the same thing today, and every future detail route would
have too. A 404 is not an error. It is a **designed state** — one the app expects,
should say something specific about, and should offer a way out of. Routing it
through the error boundary means every detail route re-invents that state, and
each one gets to forget the exit.

The obvious fix — make the loader `await ensureQueryData`, catch the 404, throw
`notFound()` — was rejected. The profile's loader is deliberately **non-blocking**
(`void prefetchQuery`), because the per-card Suspense skeletons are the loading UX
that [ADR-0915](0915-the-player-profile-is-viewer-aware.md) designed. Making the
loader await would block navigation on the whole profile bundle and delete that
design in order to satisfy a rulebook. We wanted the rule's *outcome* without its
implied mechanism.

## Decision

**A resource 404 is converted to a router `notFound()` at the query boundary, and
every detail route declares its own `notFoundComponent`.** The loader stays
non-blocking.

The conversion happens **inside the `queryFn`**, so the 404 never becomes an
`ApiError` that the error boundary could see:

```ts
// api/players.ts — inside playerByIdQueryOptions
queryFn: async ({ client }) => {
  try {
    return unwrap('load player', await api.GET('/v1/players/{player_id}', { … }))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw notFound()
    throw error
  }
},
```

The route then declares the boundary that catches it:

```ts
export const Route = createFileRoute('/_app/players/$userId')({
  …,
  errorComponent: PlayerRouteError,   // 5xx / network / 401 / 403 — retryable
  notFoundComponent: PlayerNotFound,  // 404 — a designed state, with a way back
})
```

The error boundary keeps everything that is genuinely an *error* and stays
retryable. The not-found boundary owns the one status that is a designed outcome.

## Consequences

**Three mechanisms do not work.** These were established empirically against
`@tanstack/react-router` **1.170.17**, not read off the docs — each looks correct
and each fails:

1. **Throwing `notFound()` from inside `errorComponent`.** Fails. The match layout
   is `CatchBoundary(errorComponent) > CatchNotFound > MatchInner` (`Match.js`), so
   `CatchNotFound` is a **child** of the error boundary. Once the error boundary is
   rendering its fallback, the not-found boundary is not mounted, and the throw
   escapes past every route to TanStack's generic "Something went wrong!" screen.
2. **Relying on `defaultNotFoundComponent`.** Fails for a *render-thrown*
   `notFound`. For a non-root route, `ResolvedNotFoundBoundary = route.options
   .notFoundComponent ? CatchNotFound : SafeFragment` — a route with no
   `notFoundComponent` **of its own** has no not-found boundary at that match at
   all. `defaultNotFoundComponent` is consulted only on the loader-thrown /
   URL-matched-nothing path. **This is the sharp edge:** a route that consumes a
   404-converting query and forgets its own `notFoundComponent` does not fall back
   gracefully — it renders the generic error screen.
3. **A `throwOnError` callback on the query.** Never runs. `useSuspenseQuery` hard-
   overrides the option (`useBaseQuery({ ...options, throwOnError:
   defaultThrowOnError, … })`). Corollary worth knowing: the `throwOnError: true`
   already present on `playerByIdQueryOptions` is **inert for every suspense
   consumer** — errors reach the boundary via React Query's *default*
   (`(_e, q) => q.state.data === undefined`), not via that flag.

**A converting query obligates all of its routes.** `playerByIdQueryOptions` is
read by the profile route, the match-history sub-route, and `usePlayerById`. When
a query converts 404s, **every** route that consumes it needs a
`notFoundComponent`. Sweep the consumers when adding a conversion.

**`notFound()` is not an `Error`.** It returns a plain object (`{ isNotFound: true }`).
Any `instanceof Error` handling it could reach — Faro, an error boundary — must
tolerate a non-Error throw.

**A converting query must not retry the 404.** The app sets no `retry` on its
QueryClient, so React Query's default `retry: 3` applies: without an opt-out, a
missing player is re-fetched three times with backoff before the `notFound()` ever
surfaces, and the user watches a skeleton for seconds to be told the player does
not exist. A 404 is not a transient failure — it will fail identically every time.
The converting query therefore sets `retry: false` (or a predicate that declines to
retry a 4xx while still retrying a 5xx). This does not *regress* anything — the
pre-existing 404→`ApiError` path had exactly the same delay — but the conversion is
the moment to fix it, because it is the moment the 404 stops being an "error" that
a retry might plausibly clear.

**Don't reuse a shell-wrapping 404 inside a shell.** `NotFoundPage` wraps
`AppShell`, and detail routes already live under `_app`'s `AppShell`. Rendering it
as a route's `notFoundComponent` nests a second shell: **two `<main>` landmarks,
two sidebars, two headers** (measured). The body is therefore split out as a
shell-less `NotFoundContent`, which is also what lets a route give it
resource-specific copy — "Player not found." / "Back to players" rather than
"Page not found." / "Back to dashboard". A 404 should name the thing that was
missing and land you where you can find it.

**This supersedes the reasoning recorded in `$userId.tsx`**, which argued that a
well-formed-but-unknown uuid "flows to `errorComponent` exactly as an unknown
player id does. The client cannot tell valid-unknown from valid-known without the
very request that fails." The premise is still true — the client *cannot* know
before the request. The conclusion no longer follows: the request's own failure is
where the conversion happens, so the client does not need to know in advance.

**Tournaments should follow.** `/tournaments/abc` currently renders a raw Pydantic
validator string in its error boundary (#992), and a valid-but-unknown tournament
id gets a hand-rolled not-found — the same two bugs, one layer over. This ADR is
the pattern to apply there; it was left out of this change only to keep the PR to
one page.
