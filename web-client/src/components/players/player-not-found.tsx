import { Link } from '@tanstack/react-router'

import { NotFoundContent } from '@/components/not-found-content'

/**
 * The player routes' `notFoundComponent` — what a well-formed but unknown
 * player id renders instead of the error boundary. See
 * `docs/adr/1001-a-missing-resource-is-a-not-found-not-an-error.md`: a missing
 * resource is a designed state, so it gets copy that names the thing that was
 * missing and a way back to somewhere the user can find it.
 *
 * **Shell-less on purpose.** The player routes already sit under `_app`, which
 * *is* an `<AppShell>`. This renders `NotFoundContent` directly rather than
 * reusing `NotFoundPage` (which wraps its own `AppShell`) — nesting a second
 * shell here would put two `<main>` landmarks, two sidebars and two headers on
 * the page. The test pins that with a zero-`<main>` assertion; don't add a
 * shell.
 *
 * No `meta` line, unlike the root 404. Echoing the requested path is the
 * *root* 404's affordance: there, the URL matched nothing, so the path is the
 * one piece of evidence the user can act on. Here the URL matched this route
 * perfectly and only the id is unknown — replaying an opaque uuid back at the
 * reader adds no information and no recovery. The recovery is the link.
 */
export function PlayerNotFound() {
  return (
    <NotFoundContent
      headline="Player not found."
      body={
        <>
          No player with that id. The URL might be off, or they&rsquo;ve been
          removed.
        </>
      }
      action={<Link to="/players">Back to players</Link>}
    />
  )
}
