import { Link } from '@tanstack/react-router'

import { NotFoundContent } from '@/components/not-found-content'

/**
 * The tournament detail route's `notFoundComponent` — what a tournament id that
 * names nothing renders instead of the error boundary. See
 * `docs/adr/1001-a-missing-resource-is-a-not-found-not-an-error.md`: a missing
 * resource is a designed state, so it gets copy that names the thing that was
 * missing and a way back to somewhere the user can find it.
 *
 * It catches TWO throws, and the whole point of the route is that they land in
 * the same place (#992, #1050, #1090):
 *
 * - a **well-formed-but-unknown** uuid — the detail query's `queryFn` gets a 404
 *   and converts it to a router `notFound()`;
 * - a **malformed** id segment (`abc`, `new`, `%20`) — the route's `params.parse`
 *   rejects a non-uuid and throws `notFound()` *before any fetch*, so a garbage
 *   URL never reaches the API and never leaks a Pydantic "Input should be a valid
 *   UUID" string into the UI.
 *
 * **Shell-less on purpose.** The tournament routes already sit under `_app`, which
 * *is* an `<AppShell>`. This renders `NotFoundContent` directly rather than
 * reusing `NotFoundPage` (which wraps its own `AppShell`) — nesting a second shell
 * here would put two `<main>` landmarks, two sidebars and two headers on the page.
 * The test pins that with a zero-`<main>` assertion; don't add a shell.
 *
 * No `meta` line, unlike the root 404. Echoing the requested path is the *root*
 * 404's affordance: there the URL matched nothing, so the path is the one piece of
 * evidence the user can act on. Here the URL matched this route perfectly and only
 * the id is unknown — replaying an opaque uuid back at the reader adds no
 * information and no recovery. The recovery is the link.
 */
export function TournamentNotFound() {
  return (
    <NotFoundContent
      headline="Tournament not found."
      body={
        <>
          No tournament with that id. It may have been deleted, or the link is
          wrong.
        </>
      }
      action={<Link to="/tournaments">Back to tournaments</Link>}
    />
  )
}
